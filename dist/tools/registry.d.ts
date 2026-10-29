import type { PolicyDecision } from "../security/policy.js";
import { SecurityPolicy } from "../security/policy.js";
import { type Redactor } from "../security/redact.js";
import type { ApprovalMode, ToolSpec } from "../types.js";
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
export declare class ToolRegistry {
    private readonly approve;
    private readonly tools;
    readonly policy: SecurityPolicy;
    private readonly options;
    constructor(approvalMode: ApprovalMode | SecurityPolicy, approve: ApprovalHandler, options?: ToolRegistryOptions);
    add(tool: ToolDefinition): this;
    specs(): ToolSpec[];
    has(name: string): boolean;
    isMutating(name: string): boolean;
    permissionOf(name: string): Permission | undefined;
    execute(name: string, arguments_: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
    private redact;
    private audit;
}
export declare function permissionOf(tool: ToolDefinition): Permission;
/** Minimal JSON-Schema check: required properties, primitive types, enums, unknown keys. */
export declare function validateArguments(schema: Record<string, unknown>, args: Record<string, unknown>): string | undefined;
export declare function stringArg(args: Record<string, unknown>, name: string, required?: boolean): string;
export declare function numberArg(args: Record<string, unknown>, name: string, fallback: number): number;
export declare function booleanArg(args: Record<string, unknown>, name: string, fallback?: boolean): boolean;
export declare function stringArrayArg(args: Record<string, unknown>, name: string): string[] | undefined;
//# sourceMappingURL=registry.d.ts.map