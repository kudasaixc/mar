import type { CheckOutcome, ToolResult } from "../tools/types.js";
import type { VerificationStatus } from "../types.js";
import { oneLine, truncateMiddle } from "../util/text.js";

export interface PlanStep {
  step: string;
  status: "pending" | "in_progress" | "done" | "blocked";
}

export interface FailureRecord {
  key: string;
  tool: string;
  summary: string;
  at: number;
}

export interface CheckRecord extends CheckOutcome {
  at: number;
}

export interface TaskStateData {
  objective: string;
  instructions: string[];
  plan: PlanStep[];
  decisions: string[];
  modifiedFiles: string[];
  failures: FailureRecord[];
  checks: CheckRecord[];
  /** Mutating tools that succeeded without reporting which files they touched. */
  untrackedChanges?: string[];
  lastModificationAt: number;
  sequence: number;
}

const MAX_DECISIONS = 40;
const MAX_FAILURES = 20;
const MAX_CHECKS = 40;
const MAX_INSTRUCTION_CHARS = 20_000;

const CHECK_PATTERN = /(^|[\s/;&|])(?:test|tests|jest|vitest|mocha|ava|tap|pytest|tox|nox|unittest|tsc|eslint|biome|prettier --check|lint|typecheck|type-check|mypy|pyright|ruff|flake8|pylint|rspec|phpunit|ctest|cargo (?:test|check|clippy|build)|go (?:test|vet|build)|make (?:test|check|lint)|gradlew? (?:test|check|build)|mvn (?:test|verify|package)|dotnet (?:test|build)|(?:npm|pnpm|yarn|bun)(?: run)? (?:test|build|lint|check|typecheck))(?=$|[\s;&|:])/;

/** Heuristic: does this command look like a verification step (tests, lint, type check, build)? */
export function looksLikeCheck(command: string): boolean {
  return CHECK_PATTERN.test(command);
}

/**
 * Structured, compaction-proof task state. It is derived from real tool outcomes
 * (files modified, commands and exit codes) plus the plan and decisions the agent
 * records with `update_plan`. It survives context compaction verbatim and is
 * persisted in session snapshots.
 */
export class TaskState {
  objective = "";
  instructions: string[] = [];
  plan: PlanStep[] = [];
  decisions: string[] = [];
  readonly modifiedFiles = new Set<string>();
  private readonly failures = new Map<string, FailureRecord>();
  checks: CheckRecord[] = [];
  readonly untrackedChanges = new Set<string>();
  private lastModificationAt = 0;
  private sequence = 0;

  addInstruction(text: string): void {
    if (!this.objective) this.objective = truncateMiddle(text, 4_000);
    this.instructions.push(text.length > MAX_INSTRUCTION_CHARS ? truncateMiddle(text, MAX_INSTRUCTION_CHARS) : text);
  }

  updatePlan(plan: PlanStep[] | undefined, decisions: string[] | undefined): void {
    if (plan) this.plan = plan.slice(0, 50).map((step) => ({ step: oneLine(step.step, 300), status: step.status }));
    for (const decision of decisions ?? []) {
      const text = oneLine(decision, 500);
      if (text && !this.decisions.includes(text)) this.decisions.push(text);
    }
    if (this.decisions.length > MAX_DECISIONS) this.decisions.splice(0, this.decisions.length - MAX_DECISIONS);
  }

  /**
   * `mutating` marks tools that may change the workspace. When such a tool
   * succeeds without saying which files it touched (a shell command, a plugin),
   * MAR assumes it may have changed files rather than claiming "no changes".
   */
  recordToolResult(tool: string, key: string, result: ToolResult, mutating = false): void {
    this.sequence += 1;
    const files = result.meta?.modifiedFiles ?? [];
    if (result.ok && files.length) {
      for (const file of files) this.modifiedFiles.add(file);
      this.lastModificationAt = this.sequence;
    } else if (result.ok && mutating && !result.meta?.check && !result.meta?.noChanges && result.meta?.modifiedFiles === undefined) {
      this.untrackedChanges.add(tool);
      this.lastModificationAt = this.sequence;
    }
    if (result.meta?.check) {
      this.checks.push({ ...result.meta.check, at: this.sequence });
      if (this.checks.length > MAX_CHECKS) this.checks.splice(0, this.checks.length - MAX_CHECKS);
    }
    if (result.ok) {
      this.failures.delete(key);
    } else {
      this.failures.set(key, { key, tool, summary: oneLine(result.output, 300), at: this.sequence });
      if (this.failures.size > MAX_FAILURES) {
        const oldest = [...this.failures.values()].sort((a, b) => a.at - b.at)[0];
        if (oldest) this.failures.delete(oldest.key);
      }
    }
  }

  knownFailures(): FailureRecord[] {
    return [...this.failures.values()].sort((a, b) => a.at - b.at);
  }

  /** Checks executed after the most recent file modification, latest result per command. */
  checksSinceLastChange(): CheckRecord[] {
    const latest = new Map<string, CheckRecord>();
    for (const check of this.checks) if (check.at > this.lastModificationAt) latest.set(check.command, check);
    return [...latest.values()];
  }

  verification(): { status: VerificationStatus; detail: string } {
    if (!this.modifiedFiles.size && !this.untrackedChanges.size) return { status: "no_changes", detail: "No files were modified by agent tools." };
    const changed = [
      this.modifiedFiles.size ? `${this.modifiedFiles.size} file(s) changed` : "",
      this.untrackedChanges.size ? `${[...this.untrackedChanges].join(", ")} may have changed files` : "",
    ].filter(Boolean).join("; ");
    const checks = this.checksSinceLastChange();
    if (!checks.length) {
      return { status: "unverified", detail: `${changed}; no tests or checks ran after the last change.` };
    }
    const failed = checks.filter((check) => !check.passed);
    if (failed.length) {
      return { status: "checks_failed", detail: `Failing after last change: ${failed.map((check) => `${check.command} (exit ${check.exitCode ?? "?"})`).join(", ")}` };
    }
    return { status: "tests_passing", detail: `Passed after last change: ${checks.map((check) => check.command).join(", ")}` };
  }

  render(): string {
    const lines: string[] = [];
    lines.push(`Objective: ${this.objective || "(not set)"}`);
    if (this.plan.length) {
      lines.push("Plan:");
      for (const step of this.plan) lines.push(`  [${step.status}] ${step.step}`);
    } else lines.push("Plan: (none recorded; use update_plan for multi-step work)");
    if (this.decisions.length) {
      lines.push("Decisions:");
      for (const decision of this.decisions) lines.push(`  - ${decision}`);
    }
    lines.push(`Modified files: ${this.modifiedFiles.size ? [...this.modifiedFiles].sort().join(", ") : "none"}`);
    const failures = this.knownFailures();
    if (failures.length) {
      lines.push("Unresolved failures:");
      for (const failure of failures) lines.push(`  - ${failure.tool} ${failure.key}: ${failure.summary}`);
    }
    const verification = this.verification();
    lines.push(`Verification: ${verification.status} — ${verification.detail}`);
    return lines.join("\n");
  }

  toJSON(): TaskStateData {
    return {
      objective: this.objective,
      instructions: this.instructions,
      plan: this.plan,
      decisions: this.decisions,
      modifiedFiles: [...this.modifiedFiles],
      failures: this.knownFailures(),
      checks: this.checks,
      untrackedChanges: [...this.untrackedChanges],
      lastModificationAt: this.lastModificationAt,
      sequence: this.sequence,
    };
  }

  static fromJSON(data: Partial<TaskStateData> | undefined): TaskState {
    const state = new TaskState();
    if (!data) return state;
    state.objective = typeof data.objective === "string" ? data.objective : "";
    state.instructions = Array.isArray(data.instructions) ? data.instructions.filter((item) => typeof item === "string") : [];
    state.plan = Array.isArray(data.plan) ? data.plan : [];
    state.decisions = Array.isArray(data.decisions) ? data.decisions : [];
    for (const file of data.modifiedFiles ?? []) state.modifiedFiles.add(file);
    for (const failure of data.failures ?? []) state.failures.set(failure.key, failure);
    state.checks = Array.isArray(data.checks) ? data.checks : [];
    for (const tool of data.untrackedChanges ?? []) state.untrackedChanges.add(tool);
    state.lastModificationAt = data.lastModificationAt ?? 0;
    state.sequence = data.sequence ?? 0;
    return state;
  }
}
