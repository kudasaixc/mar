import { randomUUID } from "node:crypto";
import { copyFile, mkdir, open, readdir, readFile, rm, stat } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { errorMessage, SessionError } from "../errors.js";
import { NO_REDACTION } from "../security/redact.js";
import { isRecord, writeFileAtomic } from "../util/fs.js";
import { MAR_VERSION } from "../version.js";
export const SESSION_SCHEMA = 2;
export function sessionsRoot() {
    return process.env.MAR_STATE_DIR ? resolve(process.env.MAR_STATE_DIR) : join(homedir(), ".local", "state", "mar", "sessions");
}
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{5,100}$/;
function newId() {
    return `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}
function pidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code === "EPERM";
    }
}
async function readJsonFile(path) {
    return JSON.parse(await readFile(path, "utf8"));
}
/**
 * Durable session storage under `<state>/sessions/<id>/`:
 * - `meta.json` (atomic) — identity, status, title;
 * - `journal.jsonl` (append-only) — messages, tool lifecycle, audit and runtime events;
 * - `snapshot.json` (atomic, previous copy kept) — conversation and task state at turn boundaries;
 * - `lock` — owning process, to prevent two processes resuming one session.
 */
export class SessionStore {
    redactor;
    onError;
    id;
    dir;
    /** Journal path (kept as `path` for 0.1 API compatibility). */
    path;
    meta;
    seq = 0;
    queue = Promise.resolve();
    handle;
    failure;
    closed = false;
    constructor(dir, meta, redactor, onError) {
        this.redactor = redactor;
        this.onError = onError;
        this.dir = dir;
        this.id = meta.id;
        this.meta = meta;
        this.path = join(dir, "journal.jsonl");
    }
    get metadata() {
        return this.meta;
    }
    /** The first persistence failure, if any. Persistence errors never crash the run but are surfaced. */
    get error() {
        return this.failure;
    }
    static async create(workspace, options = {}) {
        const root = sessionsRoot();
        await mkdir(root, { recursive: true, mode: 0o700 });
        const id = newId();
        const dir = join(root, id);
        await mkdir(dir, { mode: 0o700 });
        const now = new Date().toISOString();
        const meta = {
            schema: SESSION_SCHEMA, id, workspace: resolve(workspace), createdAt: now, updatedAt: now,
            status: "active", title: options.title ?? "", marVersion: MAR_VERSION, turns: 0,
        };
        const store = new SessionStore(dir, meta, options.redactor ?? NO_REDACTION, options.onError);
        await store.acquireLock();
        await store.writeMeta();
        await store.append("session:start", { workspace: meta.workspace, marVersion: MAR_VERSION });
        return store;
    }
    /** Open an existing session for resumption (takes the lock). Accepts a unique id prefix or suffix. */
    static async open(idOrPrefix, options = {}) {
        const id = await SessionStore.resolveId(idOrPrefix);
        const root = sessionsRoot();
        let dir = join(root, id);
        const isDir = await stat(dir).then((info) => info.isDirectory(), () => false);
        if (!isDir) {
            const legacy = join(root, `${id}.jsonl`);
            if (!(await stat(legacy).then((info) => info.isFile(), () => false)))
                throw new SessionError(`Session not found: ${idOrPrefix}`);
            dir = await migrateLegacy(root, id);
        }
        const meta = await loadMeta(dir);
        const store = new SessionStore(dir, meta, options.redactor ?? NO_REDACTION, options.onError);
        await store.acquireLock();
        store.seq = await lastSeq(store.path);
        await store.setStatus("active");
        return store;
    }
    static async resolveId(idOrPrefix) {
        if (!idOrPrefix || !/^[A-Za-z0-9_.-]+$/.test(idOrPrefix))
            throw new SessionError(`Invalid session id: ${idOrPrefix}`);
        const all = await SessionStore.list();
        const exact = all.find((session) => session.id === idOrPrefix);
        if (exact)
            return exact.id;
        const matches = all.filter((session) => session.id.startsWith(idOrPrefix) || session.id.endsWith(idOrPrefix));
        if (matches.length === 1)
            return matches[0].id;
        if (matches.length > 1)
            throw new SessionError(`Session id "${idOrPrefix}" is ambiguous (${matches.length} matches).`);
        throw new SessionError(`Session not found: ${idOrPrefix}`);
    }
    /** All sessions, newest first, including unconverted 0.1 logs. Corrupt entries are skipped, not fatal. */
    static async list() {
        const root = sessionsRoot();
        let entries;
        try {
            entries = await readdir(root, { withFileTypes: true });
        }
        catch {
            return [];
        }
        const listings = [];
        const dirs = new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
        for (const entry of entries) {
            if (entry.isDirectory() && ID_PATTERN.test(entry.name)) {
                try {
                    const meta = await loadMeta(join(root, entry.name));
                    const locked = await lockOwner(join(root, entry.name)) !== undefined;
                    const status = meta.status === "active" && !locked ? "interrupted" : meta.status;
                    listings.push({ ...meta, status, legacy: false, locked });
                }
                catch {
                    // Unreadable session directory: listed by `mar doctor`, skipped here.
                }
            }
            else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
                const id = entry.name.slice(0, -".jsonl".length);
                if (dirs.has(id) || !ID_PATTERN.test(id))
                    continue;
                const legacy = await readLegacy(join(root, entry.name)).catch(() => undefined);
                if (legacy)
                    listings.push({ ...legacy.meta, legacy: true, locked: false });
            }
        }
        return listings.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }
    /** Most recent session for a workspace (or overall). */
    static async latest(workspace) {
        const target = workspace ? resolve(workspace) : undefined;
        return (await SessionStore.list()).find((session) => !target || session.workspace === target);
    }
    static async delete(idOrPrefix) {
        const id = await SessionStore.resolveId(idOrPrefix);
        const root = sessionsRoot();
        const dir = join(root, id);
        const owner = await lockOwner(dir);
        if (owner !== undefined)
            throw new SessionError(`Session ${id} is in use by process ${owner}.`);
        await rm(dir, { recursive: true, force: true });
        await rm(join(root, `${id}.jsonl`), { force: true });
        return id;
    }
    /** Read a session without locking it (inspection). */
    static async inspect(idOrPrefix) {
        const id = await SessionStore.resolveId(idOrPrefix);
        const root = sessionsRoot();
        const dir = join(root, id);
        if (await stat(dir).then((info) => info.isDirectory(), () => false)) {
            const { records, corrupt } = await readJournal(join(dir, "journal.jsonl"));
            return { meta: await loadMeta(dir), records, corrupt, legacy: false };
        }
        const legacy = await readLegacy(join(root, `${id}.jsonl`));
        return { meta: legacy.meta, records: legacy.records, corrupt: legacy.corrupt, legacy: true };
    }
    /** Queue a journal record. Writes are serialized; failures are recorded and reported once. */
    append(type, data, agent) {
        if (this.closed)
            return Promise.resolve();
        this.seq += 1;
        const record = { seq: this.seq, ts: new Date().toISOString(), type, ...(agent ? { agent } : {}), data: this.redactor.redactValue(data) };
        const line = `${JSON.stringify(record)}\n`;
        this.queue = this.queue.then(async () => {
            if (this.failure)
                return;
            try {
                this.handle ??= await open(this.path, "a", 0o600);
                await this.handle.write(line);
            }
            catch (error) {
                this.fail(error);
            }
        });
        return this.queue;
    }
    get sequence() {
        return this.seq;
    }
    async flush() {
        await this.queue;
    }
    /** Atomically persist a snapshot; the previous one is kept as a fallback. */
    async saveSnapshot(snapshot) {
        await this.flush();
        const full = { schema: SESSION_SCHEMA, seq: this.seq, savedAt: new Date().toISOString(), ...this.redactor.redactValue(snapshot) };
        const path = join(this.dir, "snapshot.json");
        try {
            await copyFile(path, join(this.dir, "snapshot.prev.json")).catch(() => undefined);
            await writeFileAtomic(path, JSON.stringify(full));
            this.meta.updatedAt = full.savedAt;
            await this.writeMeta();
        }
        catch (error) {
            this.fail(error);
        }
    }
    async update(fields) {
        this.meta = { ...this.meta, ...fields, updatedAt: new Date().toISOString() };
        try {
            await this.writeMeta();
        }
        catch (error) {
            this.fail(error);
        }
    }
    async setStatus(status) {
        await this.update({ status });
    }
    /** Reconstruct the master conversation for resumption. */
    async recover(masterName) {
        await this.flush();
        const snapshot = await loadSnapshot(this.dir);
        const { records, corrupt } = await readJournal(this.path);
        let messages = snapshot?.master.messages ? [...snapshot.master.messages] : [];
        const after = snapshot?.seq ?? 0;
        const started = new Set();
        for (const record of records) {
            if (record.agent !== masterName && record.agent !== "*")
                continue;
            if (record.type === "tool:start" && isRecord(record.data) && typeof record.data.callId === "string")
                started.add(record.data.callId);
            if (record.seq <= after)
                continue;
            if (record.type === "message" && isRecord(record.data))
                messages.push(record.data);
            if (record.type === "compaction" && isRecord(record.data) && Array.isArray(record.data.messages)) {
                messages = [...record.data.messages];
            }
        }
        const repaired = repairToolHistory(messages, started);
        return {
            meta: this.meta,
            ...(snapshot ? { snapshot } : {}),
            messages: repaired.messages,
            ...(snapshot?.master.taskState ? { taskState: snapshot.master.taskState } : {}),
            interruptedCalls: repaired.interrupted,
            corruptRecords: corrupt,
        };
    }
    async close(status) {
        if (this.closed)
            return;
        if (status)
            await this.setStatus(status);
        await this.flush();
        this.closed = true;
        await this.handle?.close().catch(() => undefined);
        this.handle = undefined;
        await rm(join(this.dir, "lock"), { force: true });
        OPEN_IN_PROCESS.delete(this.dir);
    }
    fail(error) {
        if (this.failure)
            return;
        this.failure = error instanceof Error ? error : new Error(String(error));
        this.onError?.(new SessionError(`Session persistence failed: ${errorMessage(error)}`, error));
    }
    async writeMeta() {
        await writeFileAtomic(join(this.dir, "meta.json"), `${JSON.stringify(this.meta, null, 2)}\n`);
    }
    async acquireLock() {
        const path = join(this.dir, "lock");
        if (OPEN_IN_PROCESS.has(this.dir))
            throw new SessionError(`Session ${this.id} is already open in this process.`);
        const owner = await lockOwner(this.dir);
        if (owner !== undefined && owner !== process.pid)
            throw new SessionError(`Session ${this.id} is already open in process ${owner}.`);
        OPEN_IN_PROCESS.add(this.dir);
        await writeFileAtomic(path, JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString() }));
    }
}
/** Session directories held by live SessionStore instances in this process. */
const OPEN_IN_PROCESS = new Set();
async function lockOwner(dir) {
    try {
        const lock = await readJsonFile(join(dir, "lock"));
        if (!isRecord(lock) || typeof lock.pid !== "number")
            return undefined;
        if (lock.host !== hostname())
            return lock.pid;
        return pidAlive(lock.pid) ? lock.pid : undefined;
    }
    catch {
        return undefined;
    }
}
async function loadMeta(dir) {
    let raw;
    try {
        raw = await readJsonFile(join(dir, "meta.json"));
    }
    catch (error) {
        throw new SessionError(`Session metadata is unreadable in ${dir}: ${errorMessage(error)}`, error);
    }
    return migrateMeta(raw);
}
/** Upgrade metadata from older schema versions. */
export function migrateMeta(raw) {
    if (!isRecord(raw) || typeof raw.id !== "string")
        throw new SessionError("Invalid session metadata.");
    const schema = typeof raw.schema === "number" ? raw.schema : 1;
    if (schema > SESSION_SCHEMA)
        throw new SessionError(`Session ${raw.id} uses schema ${schema}, newer than this MAR supports (${SESSION_SCHEMA}). Upgrade MAR.`);
    return {
        schema: SESSION_SCHEMA,
        id: raw.id,
        workspace: typeof raw.workspace === "string" ? raw.workspace : "",
        createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date(0).toISOString(),
        updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date(0).toISOString(),
        status: ["active", "completed", "interrupted", "failed"].includes(String(raw.status)) ? raw.status : "interrupted",
        title: typeof raw.title === "string" ? raw.title : "",
        marVersion: typeof raw.marVersion === "string" ? raw.marVersion : "unknown",
        turns: typeof raw.turns === "number" ? raw.turns : 0,
        ...(typeof raw.migratedFrom === "string" ? { migratedFrom: raw.migratedFrom } : {}),
    };
}
async function loadSnapshot(dir) {
    for (const name of ["snapshot.json", "snapshot.prev.json"]) {
        try {
            const raw = await readJsonFile(join(dir, name));
            if (isRecord(raw) && isRecord(raw.master) && Array.isArray(raw.master.messages) && typeof raw.seq === "number") {
                return raw;
            }
        }
        catch {
            // Try the previous snapshot, then fall back to the journal alone.
        }
    }
    return undefined;
}
/** Parse a journal, skipping corrupt or truncated lines instead of failing. */
export async function readJournal(path) {
    let text;
    try {
        text = await readFile(path, "utf8");
    }
    catch {
        return { records: [], corrupt: 0 };
    }
    const records = [];
    let corrupt = 0;
    for (const line of text.split("\n")) {
        if (!line.trim())
            continue;
        try {
            const record = JSON.parse(line);
            if (typeof record.seq === "number" && typeof record.type === "string")
                records.push(record);
            else
                corrupt += 1;
        }
        catch {
            corrupt += 1;
        }
    }
    return { records, corrupt };
}
async function lastSeq(path) {
    const { records } = await readJournal(path);
    return records.reduce((max, record) => Math.max(max, record.seq), 0);
}
/**
 * Make a recovered history valid for providers: every assistant tool call gets a
 * result. Missing results become explicit synthetic errors — the calls are never
 * re-executed automatically, because their side effects may already have happened.
 */
export function repairToolHistory(messages, started = new Set()) {
    const result = [];
    const interrupted = [];
    for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        if (message.role === "tool") {
            // Orphan tool results (no preceding call) are dropped by the loop below.
            continue;
        }
        result.push(message);
        if (message.role !== "assistant" || !message.toolCalls?.length)
            continue;
        const results = new Map();
        let next = index + 1;
        while (next < messages.length && messages[next].role === "tool") {
            const tool = messages[next];
            if (tool.toolCallId)
                results.set(tool.toolCallId, tool);
            next += 1;
        }
        for (const call of message.toolCalls) {
            const existing = results.get(call.id);
            if (existing) {
                result.push(existing);
                continue;
            }
            const wasStarted = started.has(call.id);
            interrupted.push({ id: call.id, name: call.name, started: wasStarted });
            result.push({
                role: "tool",
                toolCallId: call.id,
                toolName: call.name,
                isError: true,
                content: wasStarted
                    ? `INTERRUPTED: this ${call.name} call started but the session ended before its result was recorded. It was NOT re-run. Its effects are unknown: inspect the workspace (files, git status, processes) before retrying.`
                    : `NOT EXECUTED: the session ended before this ${call.name} call started. It is safe to issue it again if still needed.`,
                meta: { synthetic: wasStarted ? "interrupted" : "not-started" },
            });
        }
        index = next - 1;
    }
    return { messages: result, interrupted };
}
async function readLegacy(path) {
    const text = await readFile(path, "utf8");
    const id = path.split(/[\\/]/).pop().replace(/\.jsonl$/, "");
    const records = [];
    const messages = [];
    let corrupt = 0;
    let workspace = "";
    let first = "";
    let last = "";
    let title = "";
    let marVersion = "0.1.0";
    for (const [index, line] of text.split("\n").entries()) {
        if (!line.trim())
            continue;
        try {
            const raw = JSON.parse(line);
            const ts = raw.timestamp ?? new Date(0).toISOString();
            first ||= ts;
            last = ts;
            records.push({ seq: index + 1, ts, type: raw.type ?? "unknown", data: raw.data });
            if (raw.type === "session:start") {
                workspace = String(raw.data?.workspace ?? "");
                marVersion = String(raw.data?.marVersion ?? marVersion);
            }
            else if (raw.type === "user:task" && typeof raw.data?.task === "string") {
                title ||= raw.data.task.slice(0, 80);
                messages.push({ role: "user", content: raw.data.task });
            }
            else if (raw.type === "assistant:result" && typeof raw.data?.result === "string") {
                messages.push({ role: "assistant", content: raw.data.result });
            }
        }
        catch {
            corrupt += 1;
        }
    }
    return {
        meta: {
            schema: 1, id, workspace, createdAt: first || new Date(0).toISOString(), updatedAt: last || new Date(0).toISOString(),
            status: "completed", title, marVersion, turns: messages.filter((message) => message.role === "user").length,
        },
        records,
        corrupt,
        messages,
    };
}
/**
 * Convert a 0.1 JSONL log to a resumable session directory. The original file is
 * left untouched. Only user tasks and final answers existed in 0.1 logs, so tool
 * history cannot be reconstructed; the resumed agent sees the prior Q&A.
 */
async function migrateLegacy(root, id) {
    const legacy = await readLegacy(join(root, `${id}.jsonl`));
    const dir = join(root, id);
    await mkdir(dir, { mode: 0o700 });
    const meta = { ...legacy.meta, schema: SESSION_SCHEMA, status: "interrupted", migratedFrom: `${id}.jsonl` };
    await writeFileAtomic(join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
    const lines = legacy.messages.map((message, index) => JSON.stringify({ seq: index + 1, ts: meta.updatedAt, type: "message", agent: "*", data: message }));
    await writeFileAtomic(join(dir, "journal.jsonl"), lines.length ? `${lines.join("\n")}\n` : "");
    return dir;
}
//# sourceMappingURL=store.js.map