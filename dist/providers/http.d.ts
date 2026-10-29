import { ProviderError } from "../errors.js";
export declare function joinUrl(base: string, path: string): string;
export declare function requireApiKey(providerId: string, envName?: string): string | undefined;
export interface RequestOptions {
    timeoutMs?: number;
    signal?: AbortSignal;
}
export declare function httpError(response: Response, text: string): ProviderError;
/** fetch with timeout, user cancellation, and normalized errors. The caller consumes the body. */
export declare function request(url: string, init: RequestInit, options?: RequestOptions): Promise<{
    response: Response;
    dispose(): void;
}>;
export declare function normalizeFetchError(error: unknown, user?: AbortSignal, timeout?: AbortSignal, timeoutMs?: number): ProviderError;
export declare function fetchJson(url: string, init: RequestInit, timeoutMsOrOptions?: number | RequestOptions): Promise<Record<string, any>>;
export interface SseEvent {
    event?: string;
    data: string;
}
/** Parse a Server-Sent Events stream. */
export declare function sse(response: Response): AsyncGenerator<SseEvent>;
/** Parse newline-delimited JSON (Ollama streaming). */
export declare function ndjson(response: Response): AsyncGenerator<Record<string, any>>;
export declare function parseJson(text: string): Record<string, any>;
/** Run a streaming request, translating mid-stream failures into ProviderErrors. */
export declare function streamRequest<T>(url: string, init: RequestInit, options: RequestOptions, consume: (response: Response) => Promise<T>): Promise<T>;
export declare function parseArguments(value: unknown): Record<string, unknown>;
export declare function contentToString(content: unknown): string;
/** Unique tool-call identifier for providers that do not supply one. */
export declare function syntheticCallId(prefix?: string): string;
/** Ensure tool-call ids are present and unique within one response. */
export declare function uniqueCallIds<T extends {
    id: string;
}>(calls: T[], prefix?: string): T[];
//# sourceMappingURL=http.d.ts.map