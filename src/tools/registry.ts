import { errorMessage, ToolError } from "../errors.js";
import type { PolicyDecision, PolicyRequest } from "../security/policy.js";
import { SecurityPolicy } from "../security/policy.js";
import { NO_REDACTION, type Redactor } from "../security/redact.js";
import type { ApprovalMode, ToolSpec } from "../types.js";
import { truncateMiddle } from "../util/text.js";
import type { ApprovalHandler, Permission, ToolContext, ToolDefinition, ToolResult } from "./types.js";

export interface AuditRecord {
  agent: string;
  tool: string;
  permission: Permission;
  decision: PolicyDecision["decision"];
  reason: string;
  approved: boolean;
  detail: string;
}

export interface ToolRegistryOptions {
  redactor?: Redactor;
  maxOutput?: number;
  onAudit?: (record: AuditRecord) => void;
  /** Whether commands run inside an isolated sandbox; shown in approval prompts. */
  isolated?: boolean;
}

/**
 * Owns tool definitions and is the only dispatch path for model tool calls. Every
 * call is validated, checked against the security policy, approved when needed,
 * audited, executed, and redacted here.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();
  readonly policy: SecurityPolicy;
  private readonly options: ToolRegistryOptions;

  constructor(approvalMode: ApprovalMode | SecurityPolicy, private readonly approve: ApprovalHandler, options: ToolRegistryOptions = {}) {
    this.policy = approvalMode instanceof SecurityPolicy ? approvalMode : new SecurityPolicy(approvalMode, [], []);
    this.options = options;
  }

  add(tool: ToolDefinition): this {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(tool.spec.name)) throw new ToolError(`Invalid tool name "${tool.spec.name}".`);
    if (this.tools.has(tool.spec.name)) throw new ToolError(`Tool "${tool.spec.name}" is already registered.`);
    this.tools.set(tool.spec.name, tool);
    return this;
  }

  specs(): ToolSpec[] {
    return [...this.tools.values()].map((tool) => tool.spec);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  isMutating(name: string): boolean {
    return this.tools.get(name)?.mutating ?? false;
  }

  permissionOf(name: string): Permission | undefined {
    const tool = this.tools.get(name);
    return tool ? permissionOf(tool) : undefined;
  }

  async execute(name: string, arguments_: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) return { ok: false, output: `Unknown tool "${name}". Available tools: ${[...this.tools.keys()].join(", ")}` };
    if (typeof arguments_ !== "object" || arguments_ === null || Array.isArray(arguments_)) {
      return { ok: false, output: "Tool arguments must be a JSON object." };
    }
    if ("raw" in arguments_ && Object.keys(arguments_).length === 1 && !hasProperty(tool.spec.parameters, "raw")) {
      return { ok: false, output: "Tool arguments were not valid JSON. Re-send the call with a valid JSON object." };
    }
    const invalid = validateArguments(tool.spec.parameters, arguments_);
    if (invalid) return { ok: false, output: `Invalid arguments for ${name}: ${invalid}` };

    const permission = permissionOf(tool);
    let command: string | string[] | undefined;
    try {
      command = tool.command?.(arguments_);
    } catch (error) {
      return { ok: false, output: errorMessage(error) };
    }
    const request: PolicyRequest = { agent: context.agent, tool: name, permission, ...(command !== undefined ? { command } : {}) };
    const decision = this.policy.decide(request);
    const detail = this.redact(tool.summarize?.(arguments_) ?? summarize(arguments_));
    let approved = decision.decision === "allow";
    if (decision.decision === "ask") {
      let answer;
      try {
        answer = await this.approve({
          agent: context.agent, tool: name, detail, permission, reason: decision.reason,
          ...(this.options.isolated !== undefined ? { isolated: this.options.isolated } : {}),
        });
      } catch (error) {
        answer = false;
        this.audit(request, decision, false, `${detail} (approval failed: ${errorMessage(error)})`);
        return { ok: false, output: `Approval could not be obtained: ${errorMessage(error)}` };
      }
      approved = answer === true || answer === "always";
      if (answer === "always") this.policy.grant(request);
    }
    this.audit(request, decision, approved, detail);
    if (decision.decision === "deny") {
      return { ok: false, output: `Tool "${name}" was refused by policy (${decision.reason}).` };
    }
    if (!approved) return { ok: false, output: "The user denied this tool call. Do not retry it unchanged; ask or choose another approach." };

    try {
      const result = await tool.execute(arguments_, context);
      if (typeof result?.ok !== "boolean" || typeof result.output !== "string") {
        return { ok: false, output: `Tool "${name}" returned an invalid result.` };
      }
      const output = this.redact(result.output);
      const max = this.options.maxOutput;
      return { ...result, output: max && output.length > max ? truncateMiddle(output, max) : output };
    } catch (error) {
      return { ok: false, output: this.redact(errorMessage(error)) };
    }
  }

  private redact(text: string): string {
    return (this.options.redactor ?? NO_REDACTION).redact(text);
  }

  private audit(request: PolicyRequest, decision: PolicyDecision, approved: boolean, detail: string): void {
    this.options.onAudit?.({
      agent: request.agent, tool: request.tool, permission: request.permission,
      decision: decision.decision, reason: decision.reason, approved, detail,
    });
  }
}

export function permissionOf(tool: ToolDefinition): Permission {
  return tool.permission ?? (tool.mutating ? "execute" : "read");
}

function summarize(value: Record<string, unknown>): string {
  const serialized = JSON.stringify(value);
  return serialized.length > 600 ? `${serialized.slice(0, 597)}...` : serialized;
}

function hasProperty(schema: Record<string, unknown>, name: string): boolean {
  const properties = schema.properties;
  return typeof properties === "object" && properties !== null && name in properties;
}

/** Minimal JSON-Schema check: required properties, primitive types, enums, unknown keys. */
export function validateArguments(schema: Record<string, unknown>, args: Record<string, unknown>): string | undefined {
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = Array.isArray(schema.required) ? schema.required as string[] : [];
  for (const key of required) if (args[key] === undefined) return `missing required "${key}"`;
  for (const [key, value] of Object.entries(args)) {
    const property = properties[key];
    if (!property) {
      if (schema.additionalProperties === false) return `unknown argument "${key}"`;
      continue;
    }
    if (value === undefined || value === null) continue;
    const type = property.type;
    const actual = Array.isArray(value) ? "array" : typeof value;
    const matches = type === undefined
      || (type === "integer" ? Number.isInteger(value) : type === actual)
      || (type === "number" && actual === "number");
    if (!matches) return `"${key}" must be ${String(type)}`;
    if (Array.isArray(property.enum) && !property.enum.includes(value)) return `"${key}" must be one of ${property.enum.join(", ")}`;
  }
  return undefined;
}

export function stringArg(args: Record<string, unknown>, name: string, required = true): string {
  const value = args[name];
  if (typeof value === "string") return value;
  if (!required && (value === undefined || value === null)) return "";
  throw new ToolError(`Argument "${name}" must be a string.`);
}

export function numberArg(args: Record<string, unknown>, name: string, fallback: number): number {
  const value = args[name];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function booleanArg(args: Record<string, unknown>, name: string, fallback = false): boolean {
  const value = args[name];
  return typeof value === "boolean" ? value : fallback;
}

export function stringArrayArg(args: Record<string, unknown>, name: string): string[] | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ToolError(`Argument "${name}" must be an array of strings.`);
  }
  return value as string[];
}
