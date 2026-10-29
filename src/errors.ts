export class MarError extends Error {
  constructor(message: string, readonly code = "MAR_ERROR", readonly cause?: unknown) {
    super(message, { cause });
    this.name = "MarError";
  }
}

export class ConfigurationError extends MarError {
  constructor(message: string) {
    super(message, "CONFIGURATION_ERROR");
    this.name = "ConfigurationError";
  }
}

/**
 * Normalized provider failure categories. `retryable` errors may be retried with
 * backoff because a completion request has no side effects; non-retryable errors
 * move to the next fallback model or terminate the run.
 */
export type ProviderErrorKind =
  | "auth"
  | "bad_request"
  | "not_found"
  | "context_overflow"
  | "rate_limit"
  | "overloaded"
  | "server"
  | "timeout"
  | "network"
  | "malformed"
  | "cancelled"
  | "unknown";

const RETRYABLE: ReadonlySet<ProviderErrorKind> = new Set(["rate_limit", "overloaded", "server", "timeout", "network", "malformed"]);

export class ProviderError extends MarError {
  readonly kind: ProviderErrorKind;
  readonly retryAfterMs: number | undefined;

  constructor(
    message: string,
    readonly status?: number,
    cause?: unknown,
    kind?: ProviderErrorKind,
    retryAfterMs?: number,
  ) {
    super(message, "PROVIDER_ERROR", cause);
    this.name = "ProviderError";
    this.kind = kind ?? (status === undefined ? "unknown" : kindFromStatus(status, message));
    this.retryAfterMs = retryAfterMs;
  }

  get retryable(): boolean {
    return RETRYABLE.has(this.kind);
  }
}

export function kindFromStatus(status: number, message = ""): ProviderErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limit";
  if (status === 529 || status === 503) return "overloaded";
  if (status === 408 || status === 425) return "timeout";
  if (status >= 500) return "server";
  if (status === 400 || status === 413 || status === 422) {
    return isContextOverflowMessage(message) ? "context_overflow" : "bad_request";
  }
  return "unknown";
}

export function isContextOverflowMessage(message: string): boolean {
  return /context(?:[ _-]?(?:length|window))?.{0,40}(?:exceed|too long|limit|overflow)|maximum context|prompt is too long|too many tokens|token limit|input is too long|reduce the length/i
    .test(message);
}

export class ToolError extends MarError {
  constructor(message: string) {
    super(message, "TOOL_ERROR");
    this.name = "ToolError";
  }
}

export class CancelledError extends MarError {
  constructor(message = "Operation cancelled.") {
    super(message, "CANCELLED");
    this.name = "CancelledError";
  }
}

export class BudgetExceededError extends MarError {
  constructor(message: string) {
    super(message, "BUDGET_EXCEEDED");
    this.name = "BudgetExceededError";
  }
}

export class ContextOverflowError extends MarError {
  constructor(message: string) {
    super(message, "CONTEXT_OVERFLOW");
    this.name = "ContextOverflowError";
  }
}

export class SessionError extends MarError {
  constructor(message: string, cause?: unknown) {
    super(message, "SESSION_ERROR", cause);
    this.name = "SessionError";
  }
}

export class SecurityError extends MarError {
  constructor(message: string) {
    super(message, "SECURITY_ERROR");
    this.name = "SecurityError";
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isCancellation(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (error instanceof CancelledError) return true;
  return error instanceof ProviderError && error.kind === "cancelled";
}
