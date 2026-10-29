import { errorMessage, ToolError } from "../errors.js";
import { SecurityPolicy } from "../security/policy.js";
import { NO_REDACTION } from "../security/redact.js";
import { truncateMiddle } from "../util/text.js";
/**
 * Owns tool definitions and is the only dispatch path for model tool calls. Every
 * call is validated, checked against the security policy, approved when needed,
 * audited, executed, and redacted here.
 */
export class ToolRegistry {
    approve;
    tools = new Map();
    policy;
    options;
    constructor(approvalMode, approve, options = {}) {
        this.approve = approve;
        this.policy = approvalMode instanceof SecurityPolicy ? approvalMode : new SecurityPolicy(approvalMode, [], []);
        this.options = options;
    }
    add(tool) {
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(tool.spec.name))
            throw new ToolError(`Invalid tool name "${tool.spec.name}".`);
        if (this.tools.has(tool.spec.name))
            throw new ToolError(`Tool "${tool.spec.name}" is already registered.`);
        this.tools.set(tool.spec.name, tool);
        return this;
    }
    specs() {
        return [...this.tools.values()].map((tool) => tool.spec);
    }
    has(name) {
        return this.tools.has(name);
    }
    isMutating(name) {
        return this.tools.get(name)?.mutating ?? false;
    }
    permissionOf(name) {
        const tool = this.tools.get(name);
        return tool ? permissionOf(tool) : undefined;
    }
    async execute(name, arguments_, context) {
        const tool = this.tools.get(name);
        if (!tool)
            return { ok: false, output: `Unknown tool "${name}". Available tools: ${[...this.tools.keys()].join(", ")}` };
        if (typeof arguments_ !== "object" || arguments_ === null || Array.isArray(arguments_)) {
            return { ok: false, output: "Tool arguments must be a JSON object." };
        }
        if ("raw" in arguments_ && Object.keys(arguments_).length === 1 && !hasProperty(tool.spec.parameters, "raw")) {
            return { ok: false, output: "Tool arguments were not valid JSON. Re-send the call with a valid JSON object." };
        }
        const invalid = validateArguments(tool.spec.parameters, arguments_);
        if (invalid)
            return { ok: false, output: `Invalid arguments for ${name}: ${invalid}` };
        const permission = permissionOf(tool);
        let command;
        try {
            command = tool.command?.(arguments_);
        }
        catch (error) {
            return { ok: false, output: errorMessage(error) };
        }
        const request = { agent: context.agent, tool: name, permission, ...(command !== undefined ? { command } : {}) };
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
            }
            catch (error) {
                answer = false;
                this.audit(request, decision, false, `${detail} (approval failed: ${errorMessage(error)})`);
                return { ok: false, output: `Approval could not be obtained: ${errorMessage(error)}` };
            }
            approved = answer === true || answer === "always";
            if (answer === "always")
                this.policy.grant(request);
        }
        this.audit(request, decision, approved, detail);
        if (decision.decision === "deny") {
            return { ok: false, output: `Tool "${name}" was refused by policy (${decision.reason}).` };
        }
        if (!approved)
            return { ok: false, output: "The user denied this tool call. Do not retry it unchanged; ask or choose another approach." };
        try {
            const result = await tool.execute(arguments_, context);
            if (typeof result?.ok !== "boolean" || typeof result.output !== "string") {
                return { ok: false, output: `Tool "${name}" returned an invalid result.` };
            }
            const output = this.redact(result.output);
            const max = this.options.maxOutput;
            return { ...result, output: max && output.length > max ? truncateMiddle(output, max) : output };
        }
        catch (error) {
            return { ok: false, output: this.redact(errorMessage(error)) };
        }
    }
    redact(text) {
        return (this.options.redactor ?? NO_REDACTION).redact(text);
    }
    audit(request, decision, approved, detail) {
        this.options.onAudit?.({
            agent: request.agent, tool: request.tool, permission: request.permission,
            decision: decision.decision, reason: decision.reason, approved, detail,
        });
    }
}
export function permissionOf(tool) {
    return tool.permission ?? (tool.mutating ? "execute" : "read");
}
function summarize(value) {
    const serialized = JSON.stringify(value);
    return serialized.length > 600 ? `${serialized.slice(0, 597)}...` : serialized;
}
function hasProperty(schema, name) {
    const properties = schema.properties;
    return typeof properties === "object" && properties !== null && name in properties;
}
/** Minimal JSON-Schema check: required properties, primitive types, enums, unknown keys. */
export function validateArguments(schema, args) {
    const properties = (schema.properties ?? {});
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required)
        if (args[key] === undefined)
            return `missing required "${key}"`;
    for (const [key, value] of Object.entries(args)) {
        const property = properties[key];
        if (!property) {
            if (schema.additionalProperties === false)
                return `unknown argument "${key}"`;
            continue;
        }
        if (value === undefined || value === null)
            continue;
        const type = property.type;
        const actual = Array.isArray(value) ? "array" : typeof value;
        const matches = type === undefined
            || (type === "integer" ? Number.isInteger(value) : type === actual)
            || (type === "number" && actual === "number");
        if (!matches)
            return `"${key}" must be ${String(type)}`;
        if (Array.isArray(property.enum) && !property.enum.includes(value))
            return `"${key}" must be one of ${property.enum.join(", ")}`;
    }
    return undefined;
}
export function stringArg(args, name, required = true) {
    const value = args[name];
    if (typeof value === "string")
        return value;
    if (!required && (value === undefined || value === null))
        return "";
    throw new ToolError(`Argument "${name}" must be a string.`);
}
export function numberArg(args, name, fallback) {
    const value = args[name];
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
export function booleanArg(args, name, fallback = false) {
    const value = args[name];
    return typeof value === "boolean" ? value : fallback;
}
export function stringArrayArg(args, name) {
    const value = args[name];
    if (value === undefined || value === null)
        return undefined;
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        throw new ToolError(`Argument "${name}" must be an array of strings.`);
    }
    return value;
}
//# sourceMappingURL=registry.js.map