import type { CompletionRequest, CompletionResponse, ModelAdapter, ProviderConfig } from "../types.js";
export declare class AnthropicAdapter implements ModelAdapter {
    readonly id: string;
    private readonly baseUrl;
    private readonly config;
    constructor(id: string, config: ProviderConfig);
    complete(request: CompletionRequest): Promise<CompletionResponse>;
}
//# sourceMappingURL=anthropic.d.ts.map