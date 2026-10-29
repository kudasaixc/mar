import type { ChatMessage, CompletionRequest, CompletionResponse, ModelAdapter, ProviderConfig } from "../types.js";
export declare function mapMessages(messages: ChatMessage[], cache?: boolean): Record<string, unknown>[];
export declare class AnthropicAdapter implements ModelAdapter {
    readonly id: string;
    private readonly baseUrl;
    private readonly config;
    constructor(id: string, config: ProviderConfig);
    complete(request: CompletionRequest): Promise<CompletionResponse>;
    private consume;
}
//# sourceMappingURL=anthropic.d.ts.map