import type { Workspace } from "./workspace.js";
/**
 * Long-running processes (dev servers, watchers) started by agents. Output is
 * bounded, every process is killed with its tree on stop/session end, and the
 * number of concurrent processes is capped.
 */
export declare class ProcessManager {
    private readonly maxProcesses;
    private readonly processes;
    private counter;
    constructor(maxProcesses?: number);
    start(workspace: Workspace, spec: {
        argv?: string[];
        command?: string;
        cwd?: string;
    }, agent: string): string;
    output(id: string, waitMs?: number): Promise<string>;
    stop(id: string): Promise<string>;
    list(): string;
    stopAll(): Promise<void>;
    private get;
}
//# sourceMappingURL=processes.d.ts.map