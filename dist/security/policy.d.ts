import type { ApprovalMode } from "../types.js";
export type Permission = "read" | "write" | "execute";
export interface PolicyRequest {
    agent: string;
    tool: string;
    permission: Permission;
    /** Command string or argv when the tool executes a program. */
    command?: string | string[];
}
export interface PolicyDecision {
    decision: "allow" | "ask" | "deny";
    reason: string;
    rule?: string;
}
/**
 * Decides whether a tool call may run. Deny rules are best-effort guardrails that
 * apply in every mode; they are not a sandbox. The authoritative boundary for
 * commands is the configured sandbox backend.
 */
export declare class SecurityPolicy {
    readonly mode: ApprovalMode;
    private readonly allowCommands;
    private readonly denyCommands;
    private readonly grants;
    constructor(mode: ApprovalMode, allowCommands: string[], denyCommands: string[]);
    decide(request: PolicyRequest): PolicyDecision;
    /** Remember an "always" answer for the rest of the session. Compound shell strings are never remembered. */
    grant(request: PolicyRequest): boolean;
}
//# sourceMappingURL=policy.d.ts.map