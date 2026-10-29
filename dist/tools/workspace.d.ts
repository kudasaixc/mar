import { type ProcessResult } from "../security/process.js";
import { type Sandbox } from "../security/sandbox.js";
import { FileLedger } from "./ledger.js";
export interface WorkspaceOptions {
    maxOutput?: number;
    commandTimeoutMs?: number;
    sandbox?: Sandbox;
    envPassthrough?: string[];
    denyCommands?: string[];
    /** Shared between agents operating in the same directory. */
    ledger?: FileLedger;
}
export interface ExecSpec {
    /** Program and arguments, executed without a shell (preferred). */
    argv?: string[];
    /** Shell command string, executed with /bin/sh -c (or cmd.exe on Windows). */
    command?: string;
    /** Workspace-relative working directory. */
    cwd?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
}
export interface ExecResult extends ProcessResult {
    commandText: string;
}
export interface EditResult {
    message: string;
    modifiedFiles: string[];
}
/**
 * The directory an agent works in. All file paths are resolved inside the root,
 * symlinks resolving outside are rejected, and reads open files with O_NOFOLLOW
 * after validation to narrow check-then-use races.
 */
export declare class Workspace {
    readonly root: string;
    readonly maxOutput: number;
    readonly commandTimeoutMs: number;
    readonly sandbox: Sandbox;
    readonly ledger: FileLedger;
    private readonly envPassthrough;
    private readonly denyCommands;
    private gitRepo;
    private constructor();
    static create(path: string, maxOutputOrOptions?: number | WorkspaceOptions, commandTimeoutMs?: number): Promise<Workspace>;
    /** Resolve a workspace-relative path, rejecting lexical and symlink escapes. */
    resolveSafe(input?: string): Promise<string>;
    displayPath(path: string): string;
    private readValidated;
    /** Current content hash or undefined when the file does not exist. */
    private currentHash;
    read(path: string, startLine?: number, endLine?: number, agent?: string): Promise<string>;
    list(path?: string, depth?: number): Promise<string>;
    /** Files tracked or untracked-but-not-ignored when in Git; a filtered walk otherwise. */
    files(path?: string, limit?: number): Promise<string[]>;
    findFiles(pattern: string, path?: string, limit?: number): Promise<string>;
    search(pattern: string, path?: string, glob?: string, options?: {
        ignoreCase?: boolean;
        literal?: boolean;
        context?: number;
        maxResults?: number;
    }): Promise<string>;
    private searchWithoutRipgrep;
    /** Atomically replace a file's content, preserving its mode, inside the workspace. */
    private commit;
    write(path: string, content: string, agent?: string): Promise<string>;
    writeFile(path: string, content: string, agent?: string): Promise<EditResult>;
    replace(path: string, oldText: string, newText: string, all?: boolean, agent?: string): Promise<string>;
    /** Apply exact-text replacements to one file atomically. Each match must be unique unless `all`. */
    edit(path: string, edits: Array<{
        oldText: string;
        newText: string;
        all?: boolean;
    }>, agent?: string): Promise<EditResult>;
    /** Apply a multi-file unified diff. All files are validated before any is written; failures roll back. */
    applyPatch(patchText: string, agent?: string): Promise<EditResult>;
    /** Execute a command through the configured sandbox. Deny rules are checked here as defense in depth. */
    exec(spec: ExecSpec): Promise<ExecResult>;
    execStreaming(spec: ExecSpec, signal?: AbortSignal, onOutput?: (chunk: string) => void): Promise<ExecResult>;
    /** Backward-compatible string API: resolves with output, rejects on failure. */
    run(command: string): Promise<string>;
    isGitRepo(): Promise<boolean>;
    /** Run Git directly on the host with a scrubbed environment (read-only operations and MAR's own worktree management). */
    git(args: string[], maxOutput?: number, signal?: AbortSignal): Promise<ProcessResult>;
    status(): Promise<string>;
    diff(options?: {
        staged?: boolean;
        path?: string;
        base?: string;
        stat?: boolean;
    }): Promise<string>;
}
export declare function formatProcessResult(result: ExecResult | ProcessResult, maxOutput: number): string;
export declare function matchesGlob(path: string, glob: string): boolean;
//# sourceMappingURL=workspace.d.ts.map