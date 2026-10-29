export type JsonSchema = Record<string, unknown>;
export interface ToolCall {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
    /** Opaque provider data that must be echoed back (for example Gemini thought signatures). */
    providerMeta?: Record<string, unknown>;
}
/** Provider-specific reasoning content that must be replayed verbatim in tool loops. */
export interface ReasoningBlock {
    provider: string;
    data: unknown;
}
export interface ChatMessage {
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    toolCalls?: ToolCall[];
    toolCallId?: string;
    toolName?: string;
    /** Tool role only: the call failed (sent as `is_error` where providers support it). */
    isError?: boolean;
    reasoning?: ReasoningBlock[];
    /** Internal markers used by context management; never sent to providers. */
    meta?: MessageMeta;
}
export interface MessageMeta {
    /** Message produced by context compaction. */
    summary?: boolean;
    /** Tool output was shortened by compaction. */
    elided?: boolean;
    /** Synthetic result for a tool call that did not complete. */
    synthetic?: "interrupted" | "cancelled" | "not-started";
}
export interface ToolSpec {
    name: string;
    description: string;
    parameters: JsonSchema;
}
export type StreamDelta = {
    type: "text";
    text: string;
} | {
    type: "reasoning";
    text: string;
} | {
    type: "tool-call";
    id: string;
    name: string;
}
/** The stream failed and will be retried; discard text already shown for this attempt. */
 | {
    type: "reset";
};
export interface CompletionRequest {
    model: string;
    messages: ChatMessage[];
    tools: ToolSpec[];
    temperature?: number;
    maxTokens?: number;
    options?: Record<string, unknown>;
    signal?: AbortSignal;
    /** Effective context window; adapters that must declare it (Ollama num_ctx) use this. */
    contextWindow?: number;
    /** When present and supported, the adapter streams and reports incremental output. */
    onDelta?: (delta: StreamDelta) => void;
}
/**
 * Normalized usage. `inputTokens` is the TOTAL prompt size including cached and
 * cache-write tokens, which are reported separately as subsets.
 */
export interface Usage {
    inputTokens?: number;
    outputTokens?: number;
    /** Input tokens served from a provider prompt cache (billed differently). */
    cachedInputTokens?: number;
    /** Input tokens written to a provider prompt cache. */
    cacheWriteTokens?: number;
    reasoningTokens?: number;
}
export interface CompletionResponse {
    content: string;
    toolCalls: ToolCall[];
    finishReason?: string;
    usage?: Usage;
    reasoning?: ReasoningBlock[];
}
export interface ModelCapabilities {
    contextWindow: number;
    maxOutputTokens: number;
    tools: boolean;
    streaming: boolean;
    parallelToolCalls: boolean;
}
export interface ModelAdapter {
    readonly id: string;
    complete(request: CompletionRequest): Promise<CompletionResponse>;
    listModels?(): Promise<string[]>;
    /** Optional capability hints for a model; configuration overrides take precedence. */
    capabilities?(model: string): Partial<ModelCapabilities>;
}
export interface ModelReference {
    provider: string;
    model: string;
}
export interface AgentProfile extends ModelReference {
    name: string;
    description: string;
    systemPrompt?: string;
    temperature?: number;
    maxTokens?: number;
    maxTurns?: number;
    options?: Record<string, unknown>;
    fallbacks?: ModelReference[];
    capabilities?: Partial<ModelCapabilities>;
    /** Fraction of the usable context window that triggers compaction (overrides runtime.context). */
    compactAt?: number;
}
/**
 * - `on-request`: reads allowed; writes and commands ask (allow rules may pre-approve commands).
 * - `auto-edit`: reads and workspace writes allowed; commands ask unless allowed by rule.
 * - `never`: autonomous; everything allowed except the deny rules.
 * - `read-only`: writes and commands are refused.
 */
export type ApprovalMode = "on-request" | "auto-edit" | "never" | "read-only";
export interface ProviderConfig {
    kind: "openai-compatible" | "anthropic" | "gemini" | "ollama" | "plugin";
    baseUrl?: string;
    apiKeyEnv?: string;
    headers?: Record<string, string>;
    options?: Record<string, unknown>;
    module?: string;
    /** Per-request timeout in milliseconds (default 180000). */
    timeoutMs?: number;
    /** Disable streaming for endpoints that do not implement it correctly. */
    stream?: boolean;
    capabilities?: Partial<ModelCapabilities>;
}
export type SandboxBackend = "host" | "bubblewrap" | "docker";
export interface SandboxConfig {
    backend: SandboxBackend;
    /** Allow network access inside the sandbox (bubblewrap/docker only). */
    network: boolean;
    /** Docker image used by the docker backend. */
    image: string;
    /** Extra read-only paths made visible inside the sandbox. */
    readOnlyPaths: string[];
}
export interface ContextSettings {
    /** Fraction of the usable window (context minus reserved output) that triggers compaction. */
    compactAt: number;
    /** Target fraction after compaction. */
    targetAfterCompaction: number;
    /** Most recent turns whose tool output is never elided. */
    keepRecentTurns: number;
    /** Older tool results longer than this are elided to head/tail excerpts. */
    maxToolResultChars: number;
    /** `model` asks the agent's model for a narrative summary; `deterministic` never calls a model. */
    summarizer: "model" | "deterministic";
}
export interface ConcurrencySettings {
    maxWorkers: number;
    /** `auto` uses Git worktrees when the workspace is a Git repository, otherwise `shared`. */
    isolation: "auto" | "worktree" | "shared";
    workerTimeoutMs: number;
    maxDelegations: number;
}
export interface BudgetSettings {
    maxCostUsd?: number;
    maxTokens?: number;
    maxRuntimeMs?: number;
}
export interface RetrySettings {
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
}
export interface Pricing {
    /** USD per million uncached input tokens. */
    input: number;
    /** USD per million output tokens. */
    output: number;
    /** USD per million cache-read input tokens (defaults to `input`). */
    cachedInput?: number;
    /** USD per million cache-write input tokens (defaults to `input`). */
    cacheWrite?: number;
}
export interface MarConfig {
    version: 2;
    providers: Record<string, ProviderConfig>;
    team: {
        master: AgentProfile;
        workers: AgentProfile[];
    };
    runtime: {
        approval: ApprovalMode;
        commandTimeoutMs: number;
        maxToolOutput: number;
        plugins: string[];
        sandbox: SandboxConfig;
        /** Command prefixes (e.g. "npm test") allowed without a prompt in on-request/auto-edit modes. */
        allowCommands: string[];
        /** Command prefixes always refused, in every mode. */
        denyCommands: string[];
        /** Environment variables passed to commands in addition to the minimal safe set. */
        envPassthrough: string[];
        /** Named verification commands, e.g. { "test": "npm test" }. */
        checks: Record<string, string>;
        stream: boolean;
        context: ContextSettings;
        concurrency: ConcurrencySettings;
        budgets: BudgetSettings;
        retry: RetrySettings;
    };
    /** Keyed by "provider/model" or "provider/*". Estimates only; not billing data. */
    pricing: Record<string, Pricing>;
}
export type VerificationStatus = "no_changes" | "unverified" | "checks_failed" | "tests_passing" | "confirmed" | "incomplete";
export type RuntimeEvent = {
    type: "agent:start";
    agent: string;
    model: string;
} | {
    type: "agent:delta";
    agent: string;
    text: string;
} | {
    type: "agent:reasoning";
    agent: string;
    text: string;
} | {
    type: "agent:stream-reset";
    agent: string;
} | {
    type: "agent:text";
    agent: string;
    text: string;
    streamed: boolean;
} | {
    type: "agent:tool";
    agent: string;
    tool: string;
    detail: string;
    callId: string;
} | {
    type: "agent:tool-result";
    agent: string;
    tool: string;
    ok: boolean;
    preview: string;
    callId: string;
    durationMs: number;
} | {
    type: "agent:fallback";
    agent: string;
    model: string;
    error: string;
} | {
    type: "agent:retry";
    agent: string;
    model: string;
    attempt: number;
    delayMs: number;
    error: string;
} | {
    type: "agent:compaction";
    agent: string;
    beforeTokens: number;
    afterTokens: number;
    strategy: string;
} | {
    type: "agent:usage";
    agent: string;
    inputTokens: number;
    outputTokens: number;
    contextTokens: number;
    contextWindow: number;
} | {
    type: "agent:warning";
    agent: string;
    message: string;
} | {
    type: "agent:end";
    agent: string;
    turns: number;
    status: string;
} | {
    type: "task:update";
    taskId: string;
    agent: string;
    status: string;
    detail?: string;
} | {
    type: "policy:decision";
    agent: string;
    tool: string;
    decision: "allow" | "ask" | "deny";
    reason: string;
    approved?: boolean;
};
export type RuntimeEventHandler = (event: RuntimeEvent) => void;
//# sourceMappingURL=types.d.ts.map