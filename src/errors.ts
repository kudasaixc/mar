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

export class ProviderError extends MarError {
  constructor(message: string, readonly status?: number, cause?: unknown) {
    super(message, "PROVIDER_ERROR", cause);
    this.name = "ProviderError";
  }
}

export class ToolError extends MarError {
  constructor(message: string) {
    super(message, "TOOL_ERROR");
    this.name = "ToolError";
  }
}
