export declare class MarError extends Error {
    readonly code: string;
    readonly cause?: unknown | undefined;
    constructor(message: string, code?: string, cause?: unknown | undefined);
}
export declare class ConfigurationError extends MarError {
    constructor(message: string);
}
export declare class ProviderError extends MarError {
    readonly status?: number | undefined;
    constructor(message: string, status?: number | undefined, cause?: unknown);
}
export declare class ToolError extends MarError {
    constructor(message: string);
}
//# sourceMappingURL=errors.d.ts.map