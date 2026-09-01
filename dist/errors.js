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
export class ProviderError extends MarError {
    status;
    constructor(message, status, cause) {
        super(message, "PROVIDER_ERROR", cause);
        this.status = status;
        this.name = "ProviderError";
    }
}
export class ToolError extends MarError {
    constructor(message) {
        super(message, "TOOL_ERROR");
        this.name = "ToolError";
    }
}
//# sourceMappingURL=errors.js.map