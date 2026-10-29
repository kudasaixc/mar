import type { TaskStateData } from "../context/task-state.js";
import { type Redactor } from "../security/redact.js";
import type { ChatMessage } from "../types.js";
export declare const SESSION_SCHEMA = 2;
export type SessionStatus = "active" | "completed" | "interrupted" | "failed";
export interface SessionMeta {
    schema: number;
    id: string;
    workspace: string;
    createdAt: string;
    updatedAt: string;
    status: SessionStatus;
    title: string;
    marVersion: string;
    turns: number;
    /** Set for sessions converted from the 0.1 JSONL log format. */
    migratedFrom?: string;
}
export interface SessionListing extends SessionMeta {
    /** True for an unconverted 0.1 log (inspectable; converted on resume). */
    legacy: boolean;
    /** The session is locked by a live process. */
    locked: boolean;
}
export interface AgentSnapshot {
    name: string;
    messages: ChatMessage[];
    taskState: TaskStateData;
}
export interface SessionSnapshot {
    schema: number;
    seq: number;
    savedAt: string;
    master: AgentSnapshot;
    tasks: unknown[];
    usage: unknown;
    memory: unknown;
}
export interface JournalRecord {
    seq: number;
    ts: string;
    type: string;
    agent?: string;
    data: unknown;
}
export interface RecoveredSession {
    meta: SessionMeta;
    snapshot?: SessionSnapshot;
    /** Master conversation reconstructed from the snapshot plus later journal records. */
    messages: ChatMessage[];
    taskState?: TaskStateData;
    /** Tool calls that had no recorded result; synthetic results were inserted. */
    interruptedCalls: Array<{
        id: string;
        name: string;
        started: boolean;
    }>;
    /** Journal lines that could not be parsed (for example a write cut short by a crash). */
    corruptRecords: number;
}
export declare function sessionsRoot(): string;
/**
 * Durable session storage under `<state>/sessions/<id>/`:
 * - `meta.json` (atomic) — identity, status, title;
 * - `journal.jsonl` (append-only) — messages, tool lifecycle, audit and runtime events;
 * - `snapshot.json` (atomic, previous copy kept) — conversation and task state at turn boundaries;
 * - `lock` — owning process, to prevent two processes resuming one session.
 */
export declare class SessionStore {
    private readonly redactor;
    private readonly onError?;
    readonly id: string;
    readonly dir: string;
    /** Journal path (kept as `path` for 0.1 API compatibility). */
    readonly path: string;
    private meta;
    private seq;
    private queue;
    private handle;
    private failure;
    private closed;
    private constructor();
    get metadata(): Readonly<SessionMeta>;
    /** The first persistence failure, if any. Persistence errors never crash the run but are surfaced. */
    get error(): Error | undefined;
    static create(workspace: string, options?: {
        title?: string;
        redactor?: Redactor;
        onError?: (error: Error) => void;
    }): Promise<SessionStore>;
    /** Open an existing session for resumption (takes the lock). Accepts a unique id prefix or suffix. */
    static open(idOrPrefix: string, options?: {
        redactor?: Redactor;
        onError?: (error: Error) => void;
    }): Promise<SessionStore>;
    static resolveId(idOrPrefix: string): Promise<string>;
    /** All sessions, newest first, including unconverted 0.1 logs. Corrupt entries are skipped, not fatal. */
    static list(): Promise<SessionListing[]>;
    /** Most recent session for a workspace (or overall). */
    static latest(workspace?: string): Promise<SessionListing | undefined>;
    static delete(idOrPrefix: string): Promise<string>;
    /** Read a session without locking it (inspection). */
    static inspect(idOrPrefix: string): Promise<{
        meta: SessionMeta;
        records: JournalRecord[];
        corrupt: number;
        legacy: boolean;
    }>;
    /** Queue a journal record. Writes are serialized; failures are recorded and reported once. */
    append(type: string, data: unknown, agent?: string): Promise<void>;
    get sequence(): number;
    flush(): Promise<void>;
    /** Atomically persist a snapshot; the previous one is kept as a fallback. */
    saveSnapshot(snapshot: Omit<SessionSnapshot, "schema" | "seq" | "savedAt">): Promise<void>;
    update(fields: Partial<Pick<SessionMeta, "title" | "turns" | "status">>): Promise<void>;
    setStatus(status: SessionStatus): Promise<void>;
    /** Reconstruct the master conversation for resumption. */
    recover(masterName: string): Promise<RecoveredSession>;
    close(status?: SessionStatus): Promise<void>;
    private fail;
    private writeMeta;
    private acquireLock;
}
/** Upgrade metadata from older schema versions. */
export declare function migrateMeta(raw: unknown): SessionMeta;
/** Parse a journal, skipping corrupt or truncated lines instead of failing. */
export declare function readJournal(path: string): Promise<{
    records: JournalRecord[];
    corrupt: number;
}>;
/**
 * Make a recovered history valid for providers: every assistant tool call gets a
 * result. Missing results become explicit synthetic errors — the calls are never
 * re-executed automatically, because their side effects may already have happened.
 */
export declare function repairToolHistory(messages: ChatMessage[], started?: ReadonlySet<string>): {
    messages: ChatMessage[];
    interrupted: Array<{
        id: string;
        name: string;
        started: boolean;
    }>;
};
//# sourceMappingURL=store.d.ts.map