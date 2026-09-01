import type { CompletionRequest, CompletionResponse, ModelAdapter, ProviderConfig } from "../types.js";
export declare class OllamaAdapter implements ModelAdapter {
    readonly id: string;
    private readonly baseUrl;
    private readonly config;
    constructor(id: string, config: ProviderConfig);
    complete(request: CompletionRequest): Promise<CompletionResponse>;
    listModels(): Promise<string[]>;
}
//# sourceMappingURL=ollama.d.ts.map