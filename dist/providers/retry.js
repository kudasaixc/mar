import { CancelledError, ProviderError } from "../errors.js";
import { sleep } from "../util/async.js";
/** Delay before retry `attempt` (1-based): exponential backoff with full jitter, honoring Retry-After. */
export function backoffDelay(attempt, settings, retryAfterMs, random = Math.random) {
    const exponential = Math.min(settings.maxDelayMs, settings.baseDelayMs * 2 ** (attempt - 1));
    const jittered = exponential / 2 + random() * (exponential / 2);
    if (retryAfterMs !== undefined)
        return Math.min(Math.max(retryAfterMs, jittered), Math.max(settings.maxDelayMs, 60_000));
    return Math.round(jittered);
}
/**
 * Retry a side-effect-free provider call on retryable failures. Tool calls are
 * never executed inside this loop: they run only after a complete response.
 */
export async function withRetry(operation, settings, signal, onRetry) {
    for (let attempt = 1;; attempt += 1) {
        if (signal?.aborted)
            throw new CancelledError();
        try {
            return await operation(attempt);
        }
        catch (error) {
            if (signal?.aborted)
                throw new CancelledError();
            const providerError = error instanceof ProviderError ? error : undefined;
            if (!providerError?.retryable || attempt >= settings.maxAttempts)
                throw error;
            const delayMs = backoffDelay(attempt, settings, providerError.retryAfterMs);
            onRetry?.({ attempt, delayMs, error: providerError });
            await sleep(delayMs, signal);
        }
    }
}
//# sourceMappingURL=retry.js.map