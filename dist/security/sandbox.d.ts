import type { SandboxBackend, SandboxConfig } from "../types.js";
export interface WrappedCommand {
    argv: string[];
    env: Record<string, string>;
    onKill?: () => Promise<void>;
}
/**
 * An execution backend for tool commands. `isolated` is true only when the backend
 * provides an OS-level boundary (mount/namespace or container isolation). The
 * `host` backend runs commands as the current user with no isolation.
 */
export interface Sandbox {
    readonly backend: SandboxBackend;
    readonly isolated: boolean;
    readonly network: boolean;
    wrap(argv: string[], cwd: string, env: Record<string, string>): WrappedCommand;
    describe(): string;
}
export interface SandboxOptions extends SandboxConfig {
    /** Directories the command may write (the workspace, worktrees, Git metadata). */
    writablePaths: string[];
}
export interface SandboxProbe {
    backend: SandboxBackend;
    available: boolean;
    detail: string;
}
export declare function probeSandbox(backend: SandboxBackend, image?: string): Promise<SandboxProbe>;
/**
 * Create the configured backend. A requested isolated backend that is unavailable
 * is a hard error: MAR never silently falls back to host execution.
 */
export declare function createSandbox(options: SandboxOptions, probe?: boolean): Promise<Sandbox>;
export declare function hostSandbox(): Sandbox;
//# sourceMappingURL=sandbox.d.ts.map