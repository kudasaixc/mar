import { type Redactor } from "../security/redact.js";
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
export declare function projectMemoryPath(stateRoot: string, workspace: string): string;
/**
 * Shared team memory with provenance. Session-scoped entries live with the session
 * snapshot; project-scoped entries persist across sessions in the user state
 * directory (never inside the repository). Writes that would overwrite another
 * author's entry require the caller to pass the version it last saw.
 */
export declare class MemoryStore {
    private readonly sessionId;
    private readonly projectFile;
    private readonly redactor;
    private readonly entries;
    private readonly limits;
    constructor(sessionId: string, projectFile: string | undefined, redactor?: Redactor, limits?: Partial<MemoryLimits>);
    private static id;
    load(): Promise<void>;
    restoreSession(raw: unknown): void;
    sessionEntries(): MemoryEntry[];
    write(input: {
        key: string;
        text: string;
        author: string;
        kind?: MemoryKind;
        scope?: MemoryScope;
        expectedVersion?: number;
        tags?: string[];
    }): Promise<MemoryEntry>;
    get(key: string, scope?: MemoryScope): MemoryEntry | undefined;
    /** Relevance-ranked retrieval: term overlap, decisions first, then recency. */
    search(query?: string, options?: {
        kind?: MemoryKind;
        scope?: MemoryScope;
        limit?: number;
    }): MemoryEntry[];
    render(entries?: MemoryEntry[]): string;
    /** Compact digest of project decisions for system prompts (bounded). */
    projectBrief(maxChars?: number): string;
    private evict;
    private persistProject;
}
export declare function memoryDir(sessions: string): string;
//# sourceMappingURL=store.d.ts.map