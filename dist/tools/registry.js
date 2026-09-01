import { ToolError } from "../errors.js";
export class ToolRegistry {
    approvalMode;
    approve;
    tools = new Map();
    constructor(approvalMode, approve) {
        this.approvalMode = approvalMode;
        this.approve = approve;
    }
    add(tool) {
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
    async execute(name, arguments_, context) {
        const tool = this.tools.get(name);
        if (!tool)
            return { ok: false, output: `Unknown tool: ${name}` };
        if (tool.mutating) {
            if (this.approvalMode === "read-only")
                return { ok: false, output: `Tool "${name}" is disabled in read-only mode.` };
            if (this.approvalMode === "on-request") {
                const approved = await this.approve({ agent: context.agent, tool: name, detail: summarize(arguments_) });
                if (!approved)
                    return { ok: false, output: "The user denied this tool call." };
            }
        }
        try {
            return await tool.execute(arguments_, context);
        }
        catch (error) {
            return { ok: false, output: error instanceof Error ? error.message : String(error) };
        }
    }
}
function summarize(value) {
    const serialized = JSON.stringify(value);
    return serialized.length > 300 ? `${serialized.slice(0, 297)}...` : serialized;
}
export function stringArg(args, name, required = true) {
    const value = args[name];
    if (typeof value === "string")
        return value;
    if (!required && value === undefined)
        return "";
    throw new ToolError(`Argument "${name}" must be a string.`);
}
export function numberArg(args, name, fallback) {
    const value = args[name];
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
//# sourceMappingURL=registry.js.map