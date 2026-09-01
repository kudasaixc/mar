import type { AgentProfile, ChatMessage, RuntimeEventHandler } from "../types.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { ToolRegistry } from "../tools/registry.js";
export interface AgentRuntimeOptions {
    profile: AgentProfile;
    providers: ProviderRegistry;
    tools: ToolRegistry;
    workspace: string;
    teamContext: string;
    onEvent: RuntimeEventHandler;
}
export declare class AgentRuntime {
    readonly profile: AgentProfile;
    private readonly providers;
    private readonly tools;
    private readonly onEvent;
    private readonly messages;
    constructor(options: AgentRuntimeOptions);
    run(input: string): Promise<string>;
    reset(): void;
    history(): readonly ChatMessage[];
    private executeSequentially;
    private executeTool;
    private completeWithFallback;
}
//# sourceMappingURL=agent.d.ts.map