import type { ApprovalMode, ToolSpec } from "../types.js";
import type { ApprovalHandler, ToolContext, ToolDefinition, ToolResult } from "./types.js";
export declare class ToolRegistry {
    private readonly approvalMode;
    private readonly approve;
    private readonly tools;
    constructor(approvalMode: ApprovalMode, approve: ApprovalHandler);
    add(tool: ToolDefinition): this;
    specs(): ToolSpec[];
    has(name: string): boolean;
    execute(name: string, arguments_: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}
export declare function stringArg(args: Record<string, unknown>, name: string, required?: boolean): string;
export declare function numberArg(args: Record<string, unknown>, name: string, fallback: number): number;
//# sourceMappingURL=registry.d.ts.map