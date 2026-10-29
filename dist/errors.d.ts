export declare class MarError extends Error {
    readonly code: string;
    readonly cause?: unknown | undefined;
    constructor(message: string, code?: string, cause?: unknown | undefined);
}
export declare class ConfigurationError extends MarError {
    constructor(message: string);
}
/**
 * Normalized provider failure categories. `retryable` errors may be retried with
 * backoff because a completion request has no side effects; non-retryable errors
 * move to the next fallback model or terminate the run.
 */
export type ProviderErrorKind = "auth" | "bad_request" | "not_found" | "context_overflow" | "rate_limit" | "overloaded" | "server" | "timeout" | "network" | "malformed" | "cancelled" | "unknown";
export declare class ProviderError extends MarError {
    readonly status?: number | undefined;
    readonly kind: ProviderErrorKind;
    readonly retryAfterMs: number | undefined;
    constructor(message: string, status?: number | undefined, cause?: unknown, kind?: ProviderErrorKind, retryAfterMs?: number);
    get retryable(): boolean;
}
export declare function kindFromStatus(status: number, message?: string): ProviderErrorKind;
export declare function isContextOverflowMessage(message: string): boolean;
export declare class ToolError extends MarError {
    constructor(message: string);
}
export declare class CancelledError extends MarError {
    constructor(message?: string);
}
export declare class BudgetExceededError extends MarError {
    constructor(message: string);
}
export declare class ContextOverflowError extends MarError {
    constructor(message: string);
}
export declare class SessionError extends MarError {
    constructor(message: string, cause?: unknown);
}
export declare class SecurityError extends MarError {
    constructor(message: string);
}
export declare function errorMessage(error: unknown): string;
export declare function isCancellation(error: unknown, signal?: AbortSignal): boolean;
//# sourceMappingURL=errors.d.ts.map