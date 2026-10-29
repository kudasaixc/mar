import type { AgentResult } from "../runtime/agent.js";
import type { RuntimeEventHandler, VerificationStatus } from "../types.js";
export type TaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "timed_out" | "blocked" | "integrated" | "conflict" | "discarded";
export interface TaskRecord {
    id: string;
    label?: string;
    agent: string;
    task: string;
    status: TaskStatus;
    dependsOn: string[];
    isolation: "worktree" | "shared";
    createdAt: string;
    startedAt?: string;
    endedAt?: string;
    output?: string;
    agentStatus?: AgentResult["status"];
    verification?: {
        status: VerificationStatus;
        detail: string;
    };
    modifiedFiles: string[];
    diffStat?: string;
    worktree?: string;
    error?: string;
}
export interface TaskManagerOptions {
    maxWorkers: number;
    timeoutMs: number;
    maxDelegations: number;
    onEvent: RuntimeEventHandler;
    /** Executes the worker; it must honor the signal. */
    execute(record: TaskRecord, signal: AbortSignal): Promise<void>;
}
/**
 * Owns delegated work: unique ids, a concurrency limit, dependency ordering by
 * label, per-task timeouts, cancellation, and an auditable status history.
 */
export declare class TaskManager {
    private readonly options;
    private readonly tasks;
    private readonly labels;
    private readonly settled;
    private readonly labelWaiters;
    private readonly semaphore;
    private readonly controller;
    private counter;
    constructor(options: TaskManagerOptions);
    get(idOrLabel: string): TaskRecord | undefined;
    list(): TaskRecord[];
    restore(records: unknown): void;
    update(record: TaskRecord, status: TaskStatus, detail?: string): void;
    /** Submit and wait for a task. Resolves with the final record (never rejects for worker failures). */
    submit(input: {
        agent: string;
        task: string;
        label?: string;
        dependsOn?: string[];
        isolation: TaskRecord["isolation"];
    }, signal?: AbortSignal): Promise<TaskRecord>;
    private run;
    private waitForDependencies;
    private dependsOnTransitively;
    private waitForLabel;
    cancelAll(): void;
    render(): string;
}
//# sourceMappingURL=tasks.d.ts.map