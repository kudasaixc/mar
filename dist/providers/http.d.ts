export declare function joinUrl(base: string, path: string): string;
export declare function requireApiKey(providerId: string, envName?: string): string | undefined;
export declare function fetchJson(url: string, init: RequestInit, timeoutMs?: number): Promise<Record<string, any>>;
export declare function parseArguments(value: unknown): Record<string, unknown>;
export declare function contentToString(content: unknown): string;
//# sourceMappingURL=http.d.ts.map