import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ToolError } from "../errors.js";
import { NO_REDACTION, type Redactor } from "../security/redact.js";
import { isRecord, writeFileAtomic } from "../util/fs.js";
import { oneLine } from "../util/text.js";

export type MemoryKind = "note" | "finding" | "decision" | "task";
export type MemoryScope = "session" | "project";

export interface MemoryEntry {
  key: string;
  kind: MemoryKind;
  scope: MemoryScope;
  text: string;
  author: string;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  tags: string[];
}

export interface MemoryLimits {
  maxEntries: number;
  maxChars: number;
}

const DEFAULT_LIMITS: MemoryLimits = { maxEntries: 200, maxChars: 4_000 };
const KINDS: MemoryKind[] = ["note", "finding", "decision", "task"];

export function projectMemoryPath(stateRoot: string, workspace: string): string {
  const hash = createHash("sha256").update(workspace).digest("hex").slice(0, 16);
  return join(stateRoot, hash, "memory.json");
}

/**
 * Shared team memory with provenance. Session-scoped entries live with the session
 * snapshot; project-scoped entries persist across sessions in the user state
 * directory (never inside the repository). Writes that would overwrite another
 * author's entry require the caller to pass the version it last saw.
 */
export class MemoryStore {
  private readonly entries = new Map<string, MemoryEntry>();
  private readonly limits: MemoryLimits;

  constructor(
    private readonly sessionId: string,
    private readonly projectFile: string | undefined,
    private readonly redactor: Redactor = NO_REDACTION,
    limits: Partial<MemoryLimits> = {},
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  private static id(scope: MemoryScope, key: string): string {
    return `${scope}:${key}`;
  }

  async load(): Promise<void> {
    if (!this.projectFile) return;
    for (const entry of await readEntries(this.projectFile)) this.entries.set(MemoryStore.id("project", entry.key), { ...entry, scope: "project" });
  }

  restoreSession(raw: unknown): void {
    if (!Array.isArray(raw)) return;
    for (const entry of raw) {
      if (validEntry(entry) && entry.scope === "session") this.entries.set(MemoryStore.id("session", entry.key), entry);
    }
  }

  sessionEntries(): MemoryEntry[] {
    return [...this.entries.values()].filter((entry) => entry.scope === "session");
  }

  async write(input: { key: string; text: string; author: string; kind?: MemoryKind; scope?: MemoryScope; expectedVersion?: number; tags?: string[] }): Promise<MemoryEntry> {
    const key = oneLine(input.key, 120);
    if (!key) throw new ToolError("Memory key cannot be empty.");
    const kind = input.kind ?? "note";
    if (!KINDS.includes(kind)) throw new ToolError(`Memory kind must be one of ${KINDS.join(", ")}.`);
    const scope = input.scope ?? "session";
    if (scope === "project" && !this.projectFile) throw new ToolError("Project memory is not available in this session.");
    const text = this.redactor.redact(input.text.trim());
    if (!text) throw new ToolError("Memory text cannot be empty.");
    if (text.length > this.limits.maxChars) throw new ToolError(`Memory text exceeds ${this.limits.maxChars} characters; store a concise summary.`);
    const id = MemoryStore.id(scope, key);
    const existing = this.entries.get(id);
    if (existing && input.expectedVersion !== undefined && input.expectedVersion !== existing.version) {
      throw new ToolError(`Conflict: "${key}" is at version ${existing.version}, not ${input.expectedVersion}. Current text by ${existing.author}:\n${existing.text}`);
    }
    if (existing && existing.author !== input.author && input.expectedVersion === undefined) {
      throw new ToolError(`Conflict: "${key}" was written by ${existing.author} (version ${existing.version}). Read it and pass expected_version=${existing.version} to replace it, or use a different key.\nCurrent text:\n${existing.text}`);
    }
    const now = new Date().toISOString();
    const entry: MemoryEntry = {
      key, kind, scope, text, author: input.author, sessionId: this.sessionId,
      createdAt: existing?.createdAt ?? now, updatedAt: now, version: (existing?.version ?? 0) + 1,
      tags: (input.tags ?? []).slice(0, 10).map((tag) => oneLine(tag, 40)),
    };
    this.entries.set(id, entry);
    this.evict(scope);
    if (scope === "project") await this.persistProject();
    return entry;
  }

  get(key: string, scope?: MemoryScope): MemoryEntry | undefined {
    return scope ? this.entries.get(MemoryStore.id(scope, key)) : this.entries.get(MemoryStore.id("session", key)) ?? this.entries.get(MemoryStore.id("project", key));
  }

  /** Relevance-ranked retrieval: term overlap, decisions first, then recency. */
  search(query = "", options: { kind?: MemoryKind; scope?: MemoryScope; limit?: number } = {}): MemoryEntry[] {
    const terms = query.toLowerCase().split(/[^a-z0-9_./-]+/).filter((term) => term.length > 1);
    const scored = [...this.entries.values()]
      .filter((entry) => (!options.kind || entry.kind === options.kind) && (!options.scope || entry.scope === options.scope))
      .map((entry) => {
        const haystack = `${entry.key} ${entry.text} ${entry.tags.join(" ")}`.toLowerCase();
        const hits = terms.filter((term) => haystack.includes(term)).length;
        return { entry, hits, score: (terms.length ? hits / terms.length : 0) * 10 + (entry.kind === "decision" ? 2 : 0) };
      })
      .filter(({ hits }) => !terms.length || hits > 0)
      .sort((a, b) => b.score - a.score || b.entry.updatedAt.localeCompare(a.entry.updatedAt));
    return scored.slice(0, Math.min(options.limit ?? 20, 100)).map(({ entry }) => entry);
  }

  render(entries = this.search()): string {
    if (!entries.length) return "No shared notes yet.";
    return entries.map((entry) => `## ${entry.key} [${entry.kind}, ${entry.scope}, v${entry.version}]\nBy ${entry.author} at ${entry.updatedAt}\n${entry.text}`).join("\n\n");
  }

  /** Compact digest of project decisions for system prompts (bounded). */
  projectBrief(maxChars = 2_000): string {
    const decisions = this.search("", { scope: "project" }).filter((entry) => entry.kind === "decision" || entry.kind === "finding");
    let brief = "";
    for (const entry of decisions) {
      const line = `- ${entry.key}: ${oneLine(entry.text, 300)}\n`;
      if (brief.length + line.length > maxChars) break;
      brief += line;
    }
    return brief.trim();
  }

  private evict(scope: MemoryScope): void {
    const scoped = [...this.entries.values()].filter((entry) => entry.scope === scope);
    if (scoped.length <= this.limits.maxEntries) return;
    // Evict the oldest non-decision entries first, then the oldest decisions.
    const order = scoped.sort((a, b) => Number(a.kind === "decision") - Number(b.kind === "decision") || a.updatedAt.localeCompare(b.updatedAt));
    for (const entry of order.slice(0, scoped.length - this.limits.maxEntries)) this.entries.delete(MemoryStore.id(scope, entry.key));
  }

  private async persistProject(): Promise<void> {
    if (!this.projectFile) return;
    // Merge with concurrent writers: keep the highest version per key.
    const onDisk = await readEntries(this.projectFile);
    const merged = new Map(onDisk.map((entry) => [entry.key, entry]));
    for (const entry of this.entries.values()) {
      if (entry.scope !== "project") continue;
      const other = merged.get(entry.key);
      if (!other || other.version <= entry.version) merged.set(entry.key, entry);
    }
    for (const entry of merged.values()) this.entries.set(MemoryStore.id("project", entry.key), { ...entry, scope: "project" });
    this.evict("project");
    const project = [...this.entries.values()].filter((entry) => entry.scope === "project");
    await writeFileAtomic(this.projectFile, `${JSON.stringify({ version: 1, entries: project }, null, 2)}\n`);
  }
}

function validEntry(value: unknown): value is MemoryEntry {
  return isRecord(value) && typeof value.key === "string" && typeof value.text === "string" && typeof value.author === "string"
    && typeof value.version === "number" && KINDS.includes(value.kind as MemoryKind);
}

async function readEntries(path: string): Promise<MemoryEntry[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    // A corrupt memory file is preserved for inspection, not silently discarded.
    throw new ToolError(`Project memory at ${path} is unreadable: ${error instanceof Error ? error.message : String(error)}. Move it aside to continue.`);
  }
  const entries = isRecord(raw) && Array.isArray(raw.entries) ? raw.entries : [];
  return entries.filter(validEntry).map((entry) => ({ ...entry, tags: Array.isArray(entry.tags) ? entry.tags : [] }));
}

export function memoryDir(sessions: string): string {
  return join(dirname(sessions), "projects");
}
