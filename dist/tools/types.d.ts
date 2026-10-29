import type { Permission } from "../security/policy.js";
import type { ToolSpec } from "../types.js";
export type { Permission } from "../security/policy.js";
export interface ToolContext {
    agent: string;
    /** Aborted when the user cancels or the agent times out. Long-running tools must honor it. */
    signal?: AbortSignal;
    callId?: string;
}
export interface CheckOutcome {
    name: string;
    command: string;
    passed: boolean;
    exitCode: number | null;
}
export interface ToolResultMeta {
    /** Workspace-relative paths changed by this call. */
    modifiedFiles?: string[];
    exitCode?: number | null;
    /** Present when the call ran a verification command (tests, lint, type check, build). */
    check?: CheckOutcome;
    timedOut?: boolean;
    cancelled?: boolean;
    truncated?: boolean;
    /** The call is known not to change files (for example a read-only allow-listed command). */
    noChanges?: boolean;
}
export interface ToolResult {
    ok: boolean;
    output: string;
    meta?: ToolResultMeta;
}
export interface ToolDefinition {
    spec: ToolSpec;
    /** Legacy flag kept for plugin compatibility: `true` maps to the `execute` permission. */
    mutating: boolean;
    /** Permission class enforced by the registry; defaults from `mutating`. */
    permission?: Permission;
    /** Command executed by this call, used by allow/deny rules and approval prompts. */
    command?(arguments_: Record<string, unknown>): string | string[] | undefined;
    /** One-line human summary shown in approval prompts. */
    summarize?(arguments_: Record<string, unknown>): string;
    execute(arguments_: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}
export type ApprovalAnswer = boolean | "always";
export type ApprovalHandler = (request: {
    agent: string;
    tool: string;
    detail: string;
    permission?: Permission;
    reason?: string;
    /** False on hosts that run commands without isolation. */
    isolated?: boolean;
}) => Promise<ApprovalAnswer>;
//# sourceMappingURL=types.d.ts.map