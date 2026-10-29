import type { ChatMessage, CompletionRequest, CompletionResponse, ModelAdapter, ProviderConfig } from "../types.js";
/** Gemini accepts an OpenAPI subset: drop unsupported JSON-Schema keywords such as additionalProperties. */
export declare function sanitizeSchema(schema: unknown): unknown;
export declare function mapContents(messages: ChatMessage[]): Array<{
    role: string;
    parts: Record<string, unknown>[];
}>;
export declare class GeminiAdapter implements ModelAdapter {
    readonly id: string;
    private readonly baseUrl;
    private readonly config;
    constructor(id: string, config: ProviderConfig);
    complete(request: CompletionRequest): Promise<CompletionResponse>;
    listModels(): Promise<string[]>;
}
//# sourceMappingURL=gemini.d.ts.map