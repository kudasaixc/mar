import { ToolError } from "../errors.js";
import type { ApprovalMode, ToolSpec } from "../types.js";
import type { ApprovalHandler, ToolContext, ToolDefinition, ToolResult } from "./types.js";

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  constructor(private readonly approvalMode: ApprovalMode, private readonly approve: ApprovalHandler) {}

  add(tool: ToolDefinition): this {
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

  async execute(name: string, arguments_: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) return { ok: false, output: `Unknown tool: ${name}` };
    if (tool.mutating) {
      if (this.approvalMode === "read-only") return { ok: false, output: `Tool "${name}" is disabled in read-only mode.` };
      if (this.approvalMode === "on-request") {
        const approved = await this.approve({ agent: context.agent, tool: name, detail: summarize(arguments_) });
        if (!approved) return { ok: false, output: "The user denied this tool call." };
      }
    }
    try {
      return await tool.execute(arguments_, context);
    } catch (error) {
      return { ok: false, output: error instanceof Error ? error.message : String(error) };
    }
  }
}

function summarize(value: Record<string, unknown>): string {
  const serialized = JSON.stringify(value);
  return serialized.length > 300 ? `${serialized.slice(0, 297)}...` : serialized;
}

export function stringArg(args: Record<string, unknown>, name: string, required = true): string {
  const value = args[name];
  if (typeof value === "string") return value;
  if (!required && value === undefined) return "";
  throw new ToolError(`Argument "${name}" must be a string.`);
}

export function numberArg(args: Record<string, unknown>, name: string, fallback: number): number {
  const value = args[name];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
