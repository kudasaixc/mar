export interface ProcessOptions {
    argv: string[];
    cwd: string;
    env: Record<string, string>;
    timeoutMs: number;
    /** Maximum characters retained per stream (head and tail are kept). */
    maxOutput: number;
    signal?: AbortSignal;
    /** Extra cleanup when the process must be killed (for example `docker kill`). */
    onKill?: () => Promise<void>;
    /** Live output observer (background processes). */
    onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
}
export interface ProcessResult {
    exitCode: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    cancelled: boolean;
    truncated: boolean;
    durationMs: number;
    /** Set when the program could not be started at all. */
    spawnError?: string;
}
/**
 * Run a program without a shell. On POSIX the child gets its own process group so
 * that timeouts and cancellation terminate the whole tree (SIGTERM, then SIGKILL).
 */
export declare function runProcess(options: ProcessOptions): Promise<ProcessResult>;
/**
 * Build the environment for tool commands: a minimal allowlist plus explicitly
 * configured pass-through variables. Provider API keys are never forwarded unless
 * the user names them in `runtime.envPassthrough`.
 */
export declare function commandEnvironment(passthrough: string[], extra?: Record<string, string>, source?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): Record<string, string>;
export declare function shellArgv(command: string): string[];
//# sourceMappingURL=process.d.ts.map