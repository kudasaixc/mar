import { ContextManager } from "../context/manager.js";
import { TaskState } from "../context/task-state.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { AgentProfile, ChatMessage, ContextSettings, RetrySettings, RuntimeEventHandler, VerificationStatus } from "../types.js";
import type { UsageTracker } from "../usage/tracker.js";
export type AgentStatus = "completed" | "max_turns" | "cancelled" | "failed" | "budget_exceeded";
export interface AgentResult {
    status: AgentStatus;
    /** Final assistant text (or the failure description). */
    output: string;
    turns: number;
    verification: {
        status: VerificationStatus;
        detail: string;
    };
    modifiedFiles: string[];
    error?: string;
}
export interface AgentSettings {
    context: ContextSettings;
    retry: RetrySettings;
    stream: boolean;
}
export declare const DEFAULT_AGENT_SETTINGS: AgentSettings;
export interface AgentRuntimeOptions {
    profile: AgentProfile;
    providers: ProviderRegistry;
    tools: ToolRegistry;
    workspace: string;
    teamContext: string;
    onEvent: RuntimeEventHandler;
    settings?: AgentSettings;
    usage?: UsageTracker;
    /** Persist a journal record (messages, tool lifecycle, compaction). */
    journal?: (type: string, data: unknown) => void;
    taskState?: TaskState;
}
/**
 * One agent's tool loop. Every provider request goes through context
 * management, retry with backoff, and the fallback chain; tool calls are only
 * executed from a complete response, never inside a retry, so side effects are
 * not replayed.
 */
export declare class AgentRuntime {
    readonly profile: AgentProfile;
    readonly taskState: TaskState;
    readonly context: ContextManager;
    private readonly providers;
    private readonly tools;
    private readonly onEvent;
    private readonly settings;
    private readonly capabilities;
    private readonly messages;
    private readonly failures;
    private readonly options;
    private running;
    constructor(options: AgentRuntimeOptions);
    get name(): string;
    get busy(): boolean;
    /** Compatibility API: the final text, or a thrown error when the run did not complete. */
    run(input: string, signal?: AbortSignal): Promise<string>;
    runDetailed(input: string, signal?: AbortSignal): Promise<AgentResult>;
    reset(): void;
    history(): readonly ChatMessage[];
    /** Replace the conversation with a recovered one (keeps the current system prompt). */
    restore(messages: readonly ChatMessage[]): void;
    contextUsage(): import("../context/manager.js").ContextUsage;
    /** Force a compaction now (the /compact command). */
    compact(signal?: AbortSignal): Promise<import("../context/manager.js").CompactionReport>;
    /** Embedders may pass a minimal registry exposing only get(); fall back to conservative defaults. */
    private capabilitiesOf;
    private push;
    private runCompaction;
    private summarizer;
    /** One model response with compaction, overflow recovery, retry, and fallback. */
    private complete;
    private completeWithFallback;
    private recordUsage;
    /**
     * Read-only tools and delegations run concurrently; anything that may write or
     * execute runs sequentially in the order the model emitted it.
     */
    private executeTools;
    private executeTool;
}
//# sourceMappingURL=agent.d.ts.map