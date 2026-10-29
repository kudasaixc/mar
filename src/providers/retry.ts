import { CancelledError, ProviderError } from "../errors.js";
import type { RetrySettings } from "../types.js";
import { sleep } from "../util/async.js";

export interface RetryNotice {
  attempt: number;
  delayMs: number;
  error: ProviderError;
}

/** Delay before retry `attempt` (1-based): exponential backoff with full jitter, honoring Retry-After. */
export function backoffDelay(attempt: number, settings: RetrySettings, retryAfterMs?: number, random = Math.random): number {
  const exponential = Math.min(settings.maxDelayMs, settings.baseDelayMs * 2 ** (attempt - 1));
  const jittered = exponential / 2 + random() * (exponential / 2);
  if (retryAfterMs !== undefined) return Math.min(Math.max(retryAfterMs, jittered), Math.max(settings.maxDelayMs, 60_000));
  return Math.round(jittered);
}

/**
 * Retry a side-effect-free provider call on retryable failures. Tool calls are
 * never executed inside this loop: they run only after a complete response.
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  settings: RetrySettings,
  signal?: AbortSignal,
  onRetry?: (notice: RetryNotice) => void,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    if (signal?.aborted) throw new CancelledError();
    try {
      return await operation(attempt);
    } catch (error) {
      if (signal?.aborted) throw new CancelledError();
      const providerError = error instanceof ProviderError ? error : undefined;
      if (!providerError?.retryable || attempt >= settings.maxAttempts) throw error;
      const delayMs = backoffDelay(attempt, settings, providerError.retryAfterMs);
      onRetry?.({ attempt, delayMs, error: providerError });
      await sleep(delayMs, signal);
    }
  }
}
