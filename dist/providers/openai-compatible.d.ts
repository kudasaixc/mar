import type { CompletionRequest, CompletionResponse, ModelAdapter, ProviderConfig } from "../types.js";
export declare class OpenAICompatibleAdapter implements ModelAdapter {
    readonly id: string;
    private readonly baseUrl;
    private readonly config;
    constructor(id: string, config: ProviderConfig);
    private get official();
    complete(request: CompletionRequest): Promise<CompletionResponse>;
    private fromJson;
    private consume;
    listModels(): Promise<string[]>;
}
//# sourceMappingURL=openai-compatible.d.ts.map