export type JsonSchema = Record<string, unknown>;
export interface ToolCall {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
}
export interface ChatMessage {
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    toolCalls?: ToolCall[];
    toolCallId?: string;
    toolName?: string;
}
export interface ToolSpec {
    name: string;
    description: string;
    parameters: JsonSchema;
}
export interface CompletionRequest {
    model: string;
    messages: ChatMessage[];
    tools: ToolSpec[];
    temperature?: number;
    maxTokens?: number;
    options?: Record<string, unknown>;
}
export interface CompletionResponse {
    content: string;
    toolCalls: ToolCall[];
    finishReason?: string;
    usage?: {
        inputTokens?: number;
        outputTokens?: number;
    };
}
export interface ModelAdapter {
    readonly id: string;
    complete(request: CompletionRequest): Promise<CompletionResponse>;
    listModels?(): Promise<string[]>;
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
}
export type ApprovalMode = "on-request" | "never" | "read-only";
export interface ProviderConfig {
    kind: "openai-compatible" | "anthropic" | "gemini" | "ollama" | "plugin";
    baseUrl?: string;
    apiKeyEnv?: string;
    headers?: Record<string, string>;
    options?: Record<string, unknown>;
    module?: string;
}
export interface MarConfig {
    version: 1;
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
    };
}
export type RuntimeEvent = {
    type: "agent:start";
    agent: string;
    model: string;
} | {
    type: "agent:text";
    agent: string;
    text: string;
} | {
    type: "agent:tool";
    agent: string;
    tool: string;
    detail: string;
} | {
    type: "agent:tool-result";
    agent: string;
    tool: string;
    ok: boolean;
    preview: string;
} | {
    type: "agent:fallback";
    agent: string;
    model: string;
    error: string;
} | {
    type: "agent:end";
    agent: string;
    turns: number;
};
export type RuntimeEventHandler = (event: RuntimeEvent) => void;
//# sourceMappingURL=types.d.ts.map