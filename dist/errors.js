export class MarError extends Error {
    code;
    cause;
    constructor(message, code = "MAR_ERROR", cause) {
        super(message, { cause });
        this.code = code;
        this.cause = cause;
        this.name = "MarError";
    }
}
export class ConfigurationError extends MarError {
    constructor(message) {
        super(message, "CONFIGURATION_ERROR");
        this.name = "ConfigurationError";
    }
}
const RETRYABLE = new Set(["rate_limit", "overloaded", "server", "timeout", "network", "malformed"]);
export class ProviderError extends MarError {
    status;
    kind;
    retryAfterMs;
    constructor(message, status, cause, kind, retryAfterMs) {
        super(message, "PROVIDER_ERROR", cause);
        this.status = status;
        this.name = "ProviderError";
        this.kind = kind ?? (status === undefined ? "unknown" : kindFromStatus(status, message));
        this.retryAfterMs = retryAfterMs;
    }
    get retryable() {
        return RETRYABLE.has(this.kind);
    }
}
export function kindFromStatus(status, message = "") {
    if (status === 401 || status === 403)
        return "auth";
    if (status === 404)
        return "not_found";
    if (status === 429)
        return "rate_limit";
    if (status === 529 || status === 503)
        return "overloaded";
    if (status === 408 || status === 425)
        return "timeout";
    if (status >= 500)
        return "server";
    if (status === 400 || status === 413 || status === 422) {
        return isContextOverflowMessage(message) ? "context_overflow" : "bad_request";
    }
    return "unknown";
}
export function isContextOverflowMessage(message) {
    return /context(?:[ _-]?(?:length|window))?.{0,40}(?:exceed|too long|limit|overflow)|maximum context|prompt is too long|too many tokens|token limit|input is too long|reduce the length/i
        .test(message);
}
export class ToolError extends MarError {
    constructor(message) {
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
    constructor(message) {
        super(message, "BUDGET_EXCEEDED");
        this.name = "BudgetExceededError";
    }
}
export class ContextOverflowError extends MarError {
    constructor(message) {
        super(message, "CONTEXT_OVERFLOW");
        this.name = "ContextOverflowError";
    }
}
export class SessionError extends MarError {
    constructor(message, cause) {
        super(message, "SESSION_ERROR", cause);
        this.name = "SessionError";
    }
}
export class SecurityError extends MarError {
    constructor(message) {
        super(message, "SECURITY_ERROR");
        this.name = "SecurityError";
    }
}
export function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
export function isCancellation(error, signal) {
    if (signal?.aborted)
        return true;
    if (error instanceof CancelledError)
        return true;
    return error instanceof ProviderError && error.kind === "cancelled";
}
//# sourceMappingURL=errors.js.map