import type { CheckOutcome, ToolResult } from "../tools/types.js";
import type { VerificationStatus } from "../types.js";
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
/** Heuristic: does this command look like a verification step (tests, lint, type check, build)? */
export declare function looksLikeCheck(command: string): boolean;
/**
 * Structured, compaction-proof task state. It is derived from real tool outcomes
 * (files modified, commands and exit codes) plus the plan and decisions the agent
 * records with `update_plan`. It survives context compaction verbatim and is
 * persisted in session snapshots.
 */
export declare class TaskState {
    objective: string;
    instructions: string[];
    plan: PlanStep[];
    decisions: string[];
    readonly modifiedFiles: Set<string>;
    private readonly failures;
    checks: CheckRecord[];
    readonly untrackedChanges: Set<string>;
    private lastModificationAt;
    private sequence;
    addInstruction(text: string): void;
    updatePlan(plan: PlanStep[] | undefined, decisions: string[] | undefined): void;
    /**
     * `mutating` marks tools that may change the workspace. When such a tool
     * succeeds without saying which files it touched (a shell command, a plugin),
     * MAR assumes it may have changed files rather than claiming "no changes".
     */
    recordToolResult(tool: string, key: string, result: ToolResult, mutating?: boolean): void;
    knownFailures(): FailureRecord[];
    /** Checks executed after the most recent file modification, latest result per command. */
    checksSinceLastChange(): CheckRecord[];
    verification(): {
        status: VerificationStatus;
        detail: string;
    };
    render(): string;
    toJSON(): TaskStateData;
    static fromJSON(data: Partial<TaskStateData> | undefined): TaskState;
}
//# sourceMappingURL=task-state.d.ts.map