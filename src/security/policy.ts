import type { ApprovalMode } from "../types.js";
import { allowedBy, deniedBy, parseCommand } from "./command.js";

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
export class SecurityPolicy {
  private readonly grants = new Set<string>();

  constructor(
    readonly mode: ApprovalMode,
    private readonly allowCommands: string[],
    private readonly denyCommands: string[],
  ) {}

  decide(request: PolicyRequest): PolicyDecision {
    if (request.command !== undefined) {
      const rule = deniedBy(request.command, this.denyCommands);
      if (rule) return { decision: "deny", reason: `matches deny rule "${rule}"`, rule };
    }
    if (request.permission === "read") return { decision: "allow", reason: "read-only tool" };
    if (this.mode === "read-only") return { decision: "deny", reason: "read-only mode" };
    if (this.mode === "never") return { decision: "allow", reason: "autonomous mode" };
    if (request.permission === "write") {
      if (this.mode === "auto-edit") return { decision: "allow", reason: "auto-edit mode permits workspace writes" };
      if (this.grants.has(`tool:${request.tool}`)) return { decision: "allow", reason: "approved for this session" };
      return { decision: "ask", reason: "workspace write" };
    }
    if (request.command !== undefined) {
      const rule = allowedBy(request.command, this.allowCommands);
      if (rule) return { decision: "allow", reason: `matches allow rule "${rule}"`, rule };
      const key = commandGrantKey(request.command);
      if (key && this.grants.has(key)) return { decision: "allow", reason: "command prefix approved for this session" };
      return { decision: "ask", reason: "command execution" };
    }
    if (this.grants.has(`tool:${request.tool}`)) return { decision: "allow", reason: "approved for this session" };
    return { decision: "ask", reason: "side-effecting tool" };
  }

  /** Remember an "always" answer for the rest of the session. Compound shell strings are never remembered. */
  grant(request: PolicyRequest): boolean {
    if (request.command !== undefined) {
      const key = commandGrantKey(request.command);
      if (!key) return false;
      this.grants.add(key);
      return true;
    }
    this.grants.add(`tool:${request.tool}`);
    return true;
  }
}

function commandGrantKey(command: string | string[]): string | undefined {
  const parsed = Array.isArray(command) ? { argv: command, complex: false } : parseCommand(command);
  if (parsed.complex || !parsed.argv.length) return undefined;
  const words = parsed.argv.filter((word, index) => index === 0 || !word.startsWith("-")).slice(0, 2);
  return `cmd:${words.join(" ")}`;
}
