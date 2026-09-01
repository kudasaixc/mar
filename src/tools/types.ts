import type { ToolSpec } from "../types.js";

export interface ToolContext {
  agent: string;
}

export interface ToolResult {
  ok: boolean;
  output: string;
}

export interface ToolDefinition {
  spec: ToolSpec;
  mutating: boolean;
  execute(arguments_: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

export type ApprovalHandler = (request: {
  agent: string;
  tool: string;
  detail: string;
}) => Promise<boolean>;
