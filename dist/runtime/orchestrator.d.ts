import { MemoryStore } from "../memory/store.js";
import { TaskManager, type TaskRecord } from "../orchestration/tasks.js";
import { Redactor } from "../security/redact.js";
import { type Sandbox } from "../security/sandbox.js";
import { type RecoveredSession, type SessionStore } from "../session/store.js";
import { type AuditRecord } from "../tools/registry.js";
import type { ApprovalHandler } from "../tools/types.js";
import { Workspace } from "../tools/workspace.js";
import type { AgentProfile, MarConfig, RuntimeEventHandler, VerificationStatus } from "../types.js";
import { UsageTracker } from "../usage/tracker.js";
import { AgentRuntime, type AgentResult } from "./agent.js";
export interface OrchestratorOptions {
    /** A v2 configuration, or an older/partial one that is migrated and normalized. */
    config: MarConfig | Record<string, unknown>;
    workspace: string;
    approve: ApprovalHandler;
    onEvent?: RuntimeEventHandler;
    autoApprove?: boolean;
    readOnly?: boolean;
    /** Persist the conversation, tool lifecycle, and snapshots here. */
    session?: SessionStore;
    /** Conversation recovered from `session` to continue. */
    recovered?: RecoveredSession;
    redactor?: Redactor;
    /** Base directory for project memory and worktrees (default: the parent of the sessions directory). */
    stateRoot?: string;
}
export interface CheckRun {
    name: string;
    command: string;
    passed: boolean;
    exitCode: number | null;
    output: string;
}
export interface RunReport extends AgentResult {
    /** Overall status: `confirmed` only when MAR itself ran the checks and they passed. */
    overall: VerificationStatus;
    tasks: TaskRecord[];
    checks?: CheckRun[];
}
/**
 * Builds the team (master + workers), owns shared services (policy, sandbox,
 * session, memory, usage, tasks) and turns delegations into isolated worker runs.
 */
export declare class Orchestrator {
    private readonly services;
    readonly config: MarConfig;
    readonly workspace: Workspace;
    readonly master: AgentRuntime;
    readonly usage: UsageTracker;
    readonly tasks: TaskManager;
    readonly memory: MemoryStore;
    readonly sandbox: Sandbox;
    readonly checks: Record<string, string>;
    readonly session: SessionStore | undefined;
    /** Static worker profiles by name (each delegation gets a fresh runtime). */
    readonly workers: ReadonlyMap<string, AgentProfile>;
    private readonly workerState;
    private readonly integration;
    private readonly processes;
    private readonly audits;
    private controller;
    private constructor();
    static create(options: OrchestratorOptions): Promise<Orchestrator>;
    /** Compatibility API: the master's final answer (throws if the run did not complete). */
    run(task: string, signal?: AbortSignal): Promise<string>;
    runTask(task: string, options?: {
        signal?: AbortSignal;
        verify?: boolean;
    }): Promise<RunReport>;
    /** Run the project's checks with MAR itself (not the model) for an independent verdict. */
    verify(signal?: AbortSignal): Promise<CheckRun[]>;
    /** Cancel the active run, its workers, and background processes. */
    cancel(): void;
    close(status?: Parameters<SessionStore["close"]>[0]): Promise<void>;
    reset(): void;
    persist(status?: string): Promise<void>;
    auditLog(): readonly AuditRecord[];
    teamStatus(): string;
    sharedNotes(): string;
    private registry;
    private teamContext;
    private orchestrationTools;
    private executeTask;
    /** Serialize integrations so each one is checked against the latest files. */
    private integrate;
    /** Make sure worktree state directories exist (used by doctor). */
    static ensureStateDirs(stateRoot?: string): Promise<void>;
}
//# sourceMappingURL=orchestrator.d.ts.map