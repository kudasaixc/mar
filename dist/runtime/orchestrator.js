import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { validateConfig } from "../config.js";
import { TaskState } from "../context/task-state.js";
import { MarError, errorMessage } from "../errors.js";
import { MemoryStore, memoryDir, projectMemoryPath } from "../memory/store.js";
import { TaskManager } from "../orchestration/tasks.js";
import { commitWorktree, createWorktree, integrateWorktree, isGitWorkTree, removeWorktree, snapshotCommit, worktreeDiff, worktreesRoot, } from "../orchestration/worktree.js";
import { loadToolPlugins } from "../plugins.js";
import { ProviderRegistry } from "../providers/registry.js";
import { SecurityPolicy } from "../security/policy.js";
import { Redactor } from "../security/redact.js";
import { redactEvents } from "../security/redact-events.js";
import { createSandbox } from "../security/sandbox.js";
import { sessionsRoot } from "../session/store.js";
import { addBuiltinTools } from "../tools/builtins.js";
import { detectChecks } from "../tools/checks.js";
import { FileLedger } from "../tools/ledger.js";
import { ProcessManager } from "../tools/processes.js";
import { stringArg, stringArrayArg, ToolRegistry } from "../tools/registry.js";
import { formatProcessResult, Workspace } from "../tools/workspace.js";
import { UsageTracker } from "../usage/tracker.js";
import { anySignal, KeyedMutex } from "../util/async.js";
import { truncateMiddle } from "../util/text.js";
import { AgentRuntime } from "./agent.js";
/**
 * Builds the team (master + workers), owns shared services (policy, sandbox,
 * session, memory, usage, tasks) and turns delegations into isolated worker runs.
 */
export class Orchestrator {
    services;
    config;
    workspace;
    master;
    usage;
    tasks;
    memory;
    sandbox;
    checks;
    session;
    /** Static worker profiles by name (each delegation gets a fresh runtime). */
    workers;
    workerState = new Map();
    integration = new KeyedMutex();
    processes = new ProcessManager();
    audits = [];
    controller = new AbortController();
    constructor(config, workspace, services, memory, usage, sandbox, checks, session, masterState) {
        this.services = services;
        this.config = config;
        this.workspace = workspace;
        this.memory = memory;
        this.usage = usage;
        this.sandbox = sandbox;
        this.checks = checks;
        this.session = session;
        this.workers = new Map(config.team.workers.map((profile) => [profile.name, profile]));
        const { concurrency } = config.runtime;
        this.tasks = new TaskManager({
            maxWorkers: concurrency.maxWorkers,
            timeoutMs: concurrency.workerTimeoutMs,
            maxDelegations: concurrency.maxDelegations,
            onEvent: services.onEvent,
            execute: (record, signal) => this.executeTask(record, signal),
        });
        const registry = this.registry(workspace, masterState, config.team.master.name);
        if (this.workers.size)
            for (const tool of this.orchestrationTools())
                registry.add(tool);
        this.master = new AgentRuntime({
            profile: config.team.master,
            providers: services.providers,
            tools: registry,
            workspace: workspace.root,
            teamContext: this.teamContext("master"),
            onEvent: services.onEvent,
            settings: services.settings,
            usage,
            taskState: masterState,
            ...(session ? { journal: (type, data) => void session.append(type, data, config.team.master.name) } : {}),
        });
    }
    static async create(options) {
        const config = validateConfig(options.config);
        const runtime = config.runtime;
        const stateRoot = options.stateRoot ?? dirname(sessionsRoot());
        const redactor = options.redactor ?? Redactor.fromEnvironment(process.env, Object.values(config.providers).flatMap((provider) => provider.apiKeyEnv ? [provider.apiKeyEnv] : []));
        const root = (await Workspace.create(options.workspace)).root;
        const sandbox = await createSandbox({ ...runtime.sandbox, writablePaths: [root] });
        const workspace = await Workspace.create(root, {
            maxOutput: runtime.maxToolOutput, commandTimeoutMs: runtime.commandTimeoutMs, sandbox,
            envPassthrough: runtime.envPassthrough, denyCommands: runtime.denyCommands, ledger: new FileLedger(),
        });
        const providers = await ProviderRegistry.create(config);
        const pluginTools = await loadToolPlugins(runtime.plugins, workspace.root);
        const approval = options.readOnly ? "read-only" : options.autoApprove ? "never" : runtime.approval;
        const policy = new SecurityPolicy(approval, runtime.allowCommands, runtime.denyCommands);
        const sessionId = options.session?.metadata.id ?? "ephemeral";
        const memory = new MemoryStore(sessionId, options.session ? projectMemoryPath(memoryDir(sessionsRoot()), workspace.root) : undefined, redactor);
        await memory.load();
        const usage = new UsageTracker(config.pricing, runtime.budgets);
        const checks = Object.keys(runtime.checks).length ? runtime.checks : await detectChecks(workspace.root);
        const masterState = TaskState.fromJSON(options.recovered?.taskState);
        const onEvent = redactEvents(options.onEvent ?? (() => undefined), redactor);
        const orchestrator = new Orchestrator(config, workspace, {
            providers, policy, redactor, pluginTools, approve: options.approve, onEvent, stateRoot,
            gitRepo: runtime.concurrency.isolation !== "shared" && await isGitWorkTree(workspace.root),
            settings: { context: runtime.context, retry: runtime.retry, stream: runtime.stream },
        }, memory, usage, sandbox, checks, options.session, masterState);
        if (runtime.concurrency.isolation === "worktree" && !orchestrator.services.gitRepo && config.team.workers.length) {
            throw new MarError("runtime.concurrency.isolation is \"worktree\" but the workspace is not a Git work tree. Use \"auto\" or \"shared\".");
        }
        if (options.recovered) {
            orchestrator.master.restore(options.recovered.messages);
            const snapshot = options.recovered.snapshot;
            if (snapshot) {
                usage.restore(snapshot.usage);
                memory.restoreSession(snapshot.memory);
                orchestrator.tasks.restore(snapshot.tasks);
            }
        }
        return orchestrator;
    }
    /** Compatibility API: the master's final answer (throws if the run did not complete). */
    async run(task, signal) {
        const report = await this.runTask(task, { ...(signal ? { signal } : {}) });
        if (report.status === "completed")
            return report.output;
        throw new MarError(report.output);
    }
    async runTask(task, options = {}) {
        if (this.controller.signal.aborted)
            this.controller = new AbortController();
        const combined = anySignal(options.signal, this.controller.signal);
        const signal = combined.signal;
        try {
            if (this.session && !this.session.metadata.title)
                await this.session.update({ title: task.slice(0, 80) });
            const result = await this.master.runDetailed(task, signal);
            const report = { ...result, output: this.services.redactor.redact(result.output), overall: result.verification.status, tasks: this.tasks.list() };
            if (options.verify && result.status === "completed")
                report.checks = await this.verify(signal);
            report.overall = overallStatus(report);
            await this.persist(result.status);
            return report;
        }
        finally {
            combined.dispose();
        }
    }
    /** Run the project's checks with MAR itself (not the model) for an independent verdict. */
    async verify(signal) {
        const runs = [];
        for (const [name, command] of Object.entries(this.checks)) {
            const result = await this.workspace.exec({ command, ...(signal ? { signal } : {}) });
            runs.push({ name, command, passed: result.exitCode === 0 && !result.timedOut && !result.cancelled, exitCode: result.exitCode, output: formatProcessResult(result, 4_000) });
            this.session?.append("verify", { name, command, exitCode: result.exitCode }, "mar");
        }
        return runs;
    }
    /** Cancel the active run, its workers, and background processes. */
    cancel() {
        this.controller.abort();
    }
    async close(status) {
        this.tasks.cancelAll();
        await this.processes.stopAll();
        await this.persist();
        await this.session?.close(status);
    }
    reset() {
        this.master.reset();
    }
    async persist(status) {
        if (!this.session)
            return;
        try {
            await this.session.saveSnapshot({
                master: { name: this.master.name, messages: [...this.master.history()], taskState: this.master.taskState.toJSON() },
                tasks: this.tasks.list(),
                usage: this.usage.toJSON(),
                memory: this.memory.sessionEntries(),
            });
            await this.session.update({ turns: this.session.metadata.turns + (status ? 1 : 0) });
        }
        catch (error) {
            this.services.onEvent({ type: "agent:warning", agent: "mar", message: `Could not save the session snapshot: ${errorMessage(error)}` });
        }
    }
    auditLog() {
        return this.audits;
    }
    teamStatus() {
        return [this.config.team.master, ...this.workers.values()]
            .map((agent, index) => `${index === 0 ? "master" : "worker"}  ${agent.name}  ${agent.provider}/${agent.model}`)
            .join("\n");
    }
    sharedNotes() {
        return this.memory.render();
    }
    registry(workspace, taskState, agent, processes = this.processes) {
        const registry = new ToolRegistry(this.services.policy, this.services.approve, {
            redactor: this.services.redactor,
            maxOutput: this.config.runtime.maxToolOutput,
            isolated: this.sandbox.isolated,
            onAudit: (record) => {
                this.audits.push(record);
                if (this.audits.length > 1_000)
                    this.audits.shift();
                this.services.onEvent({ type: "policy:decision", agent: record.agent, tool: record.tool, decision: record.decision, reason: record.reason, approved: record.approved });
                this.session?.append("audit", record, agent);
            },
        });
        addBuiltinTools(registry, { workspace, memory: this.memory, taskState, processes, checks: this.checks });
        for (const tool of this.services.pluginTools)
            registry.add(tool);
        return registry;
    }
    teamContext(role) {
        const team = this.workers.size
            ? `Team members:\n${[...this.workers.values()].map((agent) => `- ${agent.name}: ${agent.description} (${agent.provider}/${agent.model})`).join("\n")}`
            : "You are currently the only configured agent.";
        const brief = this.memory.projectBrief();
        const memory = brief ? `\nProject decisions and findings from earlier sessions (verify before relying on them):\n${brief}` : "";
        if (role === "worker") {
            return `${team}${memory}\nYou are a worker. Complete the delegated task directly, verify it, and report concrete results. You cannot delegate.`;
        }
        const isolation = this.services.gitRepo
            ? "Each delegation runs in its own Git worktree created from the current files; its changes are integrated back with a conflict check (integrate=false lets you review with task_diff first)."
            : "Workers edit this workspace directly; concurrent edits to the same file are detected and refused, so give workers disjoint files.";
        return `${team}${memory}\nYou are the master. Decompose work, delegate independent parts, integrate results, and perform the final verification yourself. Multiple delegate calls in one response run concurrently (up to ${this.config.runtime.concurrency.maxWorkers} at a time); use label/depends_on to order dependent work. ${isolation}`;
    }
    orchestrationTools() {
        const names = [...this.workers.keys()];
        return [
            {
                spec: {
                    name: "delegate",
                    description: "Delegate a self-contained task to a worker and wait for its result. Emit several delegate calls in one response to run independent work concurrently.",
                    parameters: {
                        type: "object",
                        properties: {
                            agent: { type: "string", enum: names },
                            task: { type: "string", description: "Precise objective, scope (files), constraints, and expected verification." },
                            label: { type: "string", description: "Optional name other delegations can depend on." },
                            depends_on: { type: "array", items: { type: "string" }, description: "Labels or task ids that must complete first." },
                            integrate: { type: "boolean", description: "Apply the worker's changes automatically when they apply cleanly (default true)." },
                        },
                        required: ["agent", "task"],
                        additionalProperties: false,
                    },
                },
                mutating: true,
                permission: "read",
                summarize: (args) => `${String(args.agent)}: ${truncateMiddle(String(args.task), 400)}`,
                execute: async (args, context) => {
                    const agent = stringArg(args, "agent");
                    if (!this.workers.has(agent))
                        return { ok: false, output: `Unknown worker "${agent}". Available: ${names.join(", ")}` };
                    const label = stringArg(args, "label", false);
                    const record = await this.tasks.submit({
                        agent, task: stringArg(args, "task"), isolation: this.services.gitRepo ? "worktree" : "shared",
                        ...(label ? { label } : {}), dependsOn: stringArrayArg(args, "depends_on") ?? [],
                    }, context.signal);
                    if (record.status === "completed" && record.isolation === "worktree" && args.integrate !== false)
                        await this.integrate(record);
                    const ok = record.status === "completed" || record.status === "integrated";
                    return { ok, output: describeTask(record), meta: { modifiedFiles: record.status === "integrated" || record.isolation === "shared" ? record.modifiedFiles : [] } };
                },
            },
            {
                spec: { name: "task_status", description: "List delegated tasks with status, verification, and changed files.", parameters: { type: "object", properties: {}, additionalProperties: false } },
                mutating: false,
                permission: "read",
                execute: async () => ({ ok: true, output: this.tasks.render() }),
            },
            {
                spec: {
                    name: "task_diff",
                    description: "Show the diff a worktree task produced (before or after integration).",
                    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
                },
                mutating: false,
                permission: "read",
                execute: async (args) => {
                    const record = this.tasks.get(stringArg(args, "id"));
                    const state = record && this.workerState.get(record.id);
                    if (!record)
                        return { ok: false, output: "Unknown task id." };
                    if (!state?.worktree || !state.head)
                        return { ok: false, output: `Task ${record.id} has no worktree diff (${record.isolation} isolation, status ${record.status}).` };
                    const diff = await worktreeDiff(state.worktree, state.head);
                    return { ok: true, output: truncateMiddle(diff || "No changes.", this.config.runtime.maxToolOutput) };
                },
            },
            {
                spec: {
                    name: "integrate_task",
                    description: "Apply a completed worktree task's changes to the workspace. Refuses (and changes nothing) if they conflict with current files.",
                    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
                },
                mutating: true,
                permission: "write",
                execute: async (args) => {
                    const record = this.tasks.get(stringArg(args, "id"));
                    if (!record)
                        return { ok: false, output: "Unknown task id." };
                    if (record.status !== "completed" && record.status !== "conflict")
                        return { ok: false, output: `Task ${record.id} is ${record.status}; only completed tasks can be integrated.` };
                    await this.integrate(record);
                    const integrated = record.status === "integrated";
                    return { ok: integrated, output: describeTask(record), meta: { modifiedFiles: integrated ? record.modifiedFiles : [] } };
                },
            },
            {
                spec: {
                    name: "discard_task",
                    description: "Discard a task's unintegrated worktree changes.",
                    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
                },
                mutating: true,
                permission: "write",
                execute: async (args) => {
                    const record = this.tasks.get(stringArg(args, "id"));
                    if (!record)
                        return { ok: false, output: "Unknown task id." };
                    if (record.status === "integrated")
                        return { ok: false, output: `Task ${record.id} is already integrated.` };
                    const state = this.workerState.get(record.id);
                    if (state?.worktree)
                        await removeWorktree(this.workspace.root, state.worktree);
                    this.workerState.delete(record.id);
                    delete record.worktree;
                    this.tasks.update(record, "discarded");
                    return { ok: true, output: `Discarded ${record.id}.` };
                },
            },
        ];
    }
    async executeTask(record, signal) {
        const profile = this.workers.get(record.agent);
        if (!profile)
            throw new MarError(`Unknown worker "${record.agent}".`);
        const runtime = this.config.runtime;
        let workspace = this.workspace;
        let state = {};
        if (record.isolation === "worktree") {
            const base = worktreesRoot(join(this.services.stateRoot, "worktrees"), this.workspace.root);
            const commit = await snapshotCommit(this.workspace.root, join(base, "tmp"));
            const worktree = await createWorktree(this.workspace.root, join(base, `${this.session?.metadata.id ?? `run-${process.pid}`}-${record.id}`), commit);
            state = { worktree };
            this.workerState.set(record.id, state);
            record.worktree = worktree.path;
            const sandbox = await createSandbox({
                ...runtime.sandbox, writablePaths: [worktree.path, worktree.gitDir], readOnlyPaths: [...runtime.sandbox.readOnlyPaths, worktree.commonDir],
            }, false);
            workspace = await Workspace.create(worktree.path, {
                maxOutput: runtime.maxToolOutput, commandTimeoutMs: runtime.commandTimeoutMs, sandbox,
                envPassthrough: runtime.envPassthrough, denyCommands: runtime.denyCommands, ledger: new FileLedger(),
            });
        }
        const taskState = new TaskState();
        const processes = new ProcessManager(4);
        const agentName = `${profile.name}#${record.id}`;
        const worker = new AgentRuntime({
            profile: { ...profile, name: profile.name },
            providers: this.services.providers,
            tools: this.registry(workspace, taskState, agentName, processes),
            workspace: workspace.root,
            teamContext: this.teamContext("worker"),
            onEvent: this.services.onEvent,
            settings: this.services.settings,
            usage: this.usage,
            taskState,
            ...(this.session ? { journal: (type, data) => void this.session?.append(type, { task: record.id, ...asObject(data) }, agentName) } : {}),
        });
        try {
            const result = await worker.runDetailed(record.task, signal);
            record.agentStatus = result.status;
            record.output = result.output;
            record.verification = result.verification;
            record.modifiedFiles = result.modifiedFiles;
            if (result.status !== "completed")
                record.error = result.error ?? result.output;
            if (state.worktree) {
                const committed = await commitWorktree(state.worktree, `MAR task ${record.id}: ${record.task.slice(0, 60)}`);
                state.head = committed.head;
                record.modifiedFiles = committed.files;
                record.diffStat = committed.stat;
            }
        }
        finally {
            await processes.stopAll();
        }
    }
    /** Serialize integrations so each one is checked against the latest files. */
    async integrate(record) {
        await this.integration.run("workspace", async () => {
            const state = this.workerState.get(record.id);
            if (!state?.worktree || !state.head) {
                record.error = "No worktree changes to integrate.";
                this.tasks.update(record, "conflict", record.error);
                return;
            }
            const scratch = join(worktreesRoot(join(this.services.stateRoot, "worktrees"), this.workspace.root), "tmp");
            const result = await integrateWorktree(this.workspace.root, state.worktree, state.head, scratch);
            if (result.applied) {
                delete record.error;
                this.tasks.update(record, "integrated", `${result.files.length} file(s)`);
                await removeWorktree(this.workspace.root, state.worktree);
                this.workerState.delete(record.id);
                delete record.worktree;
            }
            else {
                record.error = `Changes conflict with the current workspace; nothing was applied. Worktree kept at ${state.worktree.path}.\n${result.conflict ?? ""}`;
                this.tasks.update(record, "conflict", "integration conflict");
            }
        });
    }
    /** Make sure worktree state directories exist (used by doctor). */
    static async ensureStateDirs(stateRoot = dirname(sessionsRoot())) {
        await mkdir(join(stateRoot, "worktrees"), { recursive: true, mode: 0o700 });
    }
}
function asObject(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : { value };
}
function describeTask(record) {
    const lines = [
        `Task ${record.id}${record.label ? ` (${record.label})` : ""} by ${record.agent}: ${record.status}`,
        record.verification ? `Worker verification: ${record.verification.status} — ${record.verification.detail}` : "",
        record.modifiedFiles.length ? `Files: ${record.modifiedFiles.join(", ")}` : "Files: none changed",
        record.diffStat ? `Diff:\n${record.diffStat}` : "",
        record.error ? `Problem: ${record.error}` : "",
        record.status === "completed" && record.isolation === "worktree" ? `Not integrated yet: review with task_diff, then integrate_task or discard_task (id ${record.id}).` : "",
        record.status === "conflict" ? `Resolve by re-delegating against the current files, or apply the change yourself (task_diff ${record.id}), then discard_task.` : "",
        `Worker report (unverified by MAR):\n${truncateMiddle(record.output ?? "(no output)", 6_000)}`,
    ];
    return lines.filter(Boolean).join("\n");
}
function overallStatus(report) {
    if (report.status !== "completed")
        return "incomplete";
    if (report.tasks.some((task) => task.status === "conflict" || (task.status === "completed" && task.isolation === "worktree")))
        return "incomplete";
    if (report.checks?.length)
        return report.checks.every((check) => check.passed) ? "confirmed" : "checks_failed";
    return report.verification.status;
}
//# sourceMappingURL=orchestrator.js.map