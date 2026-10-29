import { ProviderError } from "../errors.js";
import type { RetrySettings } from "../types.js";
export interface RetryNotice {
    attempt: number;
    delayMs: number;
    error: ProviderError;
}
/** Delay before retry `attempt` (1-based): exponential backoff with full jitter, honoring Retry-After. */
export declare function backoffDelay(attempt: number, settings: RetrySettings, retryAfterMs?: number, random?: () => number): number;
/**
 * Retry a side-effect-free provider call on retryable failures. Tool calls are
 * never executed inside this loop: they run only after a complete response.
 */
export declare function withRetry<T>(operation: (attempt: number) => Promise<T>, settings: RetrySettings, signal?: AbortSignal, onRetry?: (notice: RetryNotice) => void): Promise<T>;
//# sourceMappingURL=retry.d.ts.map