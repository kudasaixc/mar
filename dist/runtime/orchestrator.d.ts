import type { MarConfig, RuntimeEventHandler } from "../types.js";
import type { ApprovalHandler } from "../tools/types.js";
import { Workspace } from "../tools/workspace.js";
import { AgentRuntime } from "./agent.js";
export interface OrchestratorOptions {
    config: MarConfig;
    workspace: string;
    approve: ApprovalHandler;
    onEvent?: RuntimeEventHandler;
    autoApprove?: boolean;
    readOnly?: boolean;
}
export declare class Orchestrator {
    readonly workspace: Workspace;
    readonly master: AgentRuntime;
    readonly workers: ReadonlyMap<string, AgentRuntime>;
    private readonly notes;
    private constructor();
    static create(options: OrchestratorOptions): Promise<Orchestrator>;
    run(task: string): Promise<string>;
    reset(): void;
    teamStatus(): string;
    sharedNotes(): string;
}
//# sourceMappingURL=orchestrator.d.ts.map