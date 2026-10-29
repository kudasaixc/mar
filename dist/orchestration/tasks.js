import { CancelledError, MarError, errorMessage } from "../errors.js";
import { anySignal, Semaphore } from "../util/async.js";
import { oneLine } from "../util/text.js";
/** Terminal statuses: the worker is no longer running. */
const SETTLED = new Set(["completed", "failed", "cancelled", "timed_out", "blocked", "integrated", "conflict", "discarded"]);
/** Statuses that satisfy a dependency. */
const SATISFIED = new Set(["completed", "integrated"]);
/** How long a dependency label may stay unknown (it may be submitted by a sibling call in the same batch). */
const LABEL_WAIT_MS = 5_000;
/**
 * Owns delegated work: unique ids, a concurrency limit, dependency ordering by
 * label, per-task timeouts, cancellation, and an auditable status history.
 */
export class TaskManager {
    options;
    tasks = new Map();
    labels = new Map();
    settled = new Map();
    labelWaiters = new Map();
    semaphore;
    controller = new AbortController();
    counter = 0;
    constructor(options) {
        this.options = options;
        this.semaphore = new Semaphore(Math.max(1, options.maxWorkers));
    }
    get(idOrLabel) {
        return this.tasks.get(idOrLabel) ?? this.tasks.get(this.labels.get(idOrLabel) ?? "");
    }
    list() {
        return [...this.tasks.values()];
    }
    restore(records) {
        if (!Array.isArray(records))
            return;
        for (const raw of records) {
            if (!raw || typeof raw !== "object" || typeof raw.id !== "string")
                continue;
            const record = { ...raw };
            // Workers do not survive a restart; anything unfinished is reported as interrupted.
            if (record.status === "running" || record.status === "pending") {
                record.status = "cancelled";
                record.error = "Interrupted: MAR stopped before this task finished.";
            }
            this.tasks.set(record.id, record);
            if (record.label)
                this.labels.set(record.label, record.id);
            const number = Number(record.id.replace(/^t/, ""));
            if (Number.isFinite(number))
                this.counter = Math.max(this.counter, number);
        }
    }
    update(record, status, detail) {
        record.status = status;
        if (SETTLED.has(status) && !record.endedAt)
            record.endedAt = new Date().toISOString();
        this.options.onEvent({ type: "task:update", taskId: record.id, agent: record.agent, status, ...(detail ? { detail: oneLine(detail, 200) } : {}) });
    }
    /** Submit and wait for a task. Resolves with the final record (never rejects for worker failures). */
    async submit(input, signal) {
        if (this.tasks.size >= this.options.maxDelegations) {
            throw new MarError(`Delegation limit reached (${this.options.maxDelegations} tasks this session). Finish the work directly or raise runtime.concurrency.maxDelegations.`);
        }
        if (input.label && this.labels.has(input.label))
            throw new MarError(`Task label "${input.label}" is already used by ${this.labels.get(input.label)}.`);
        const id = `t${++this.counter}`;
        const record = {
            id, agent: input.agent, task: input.task, status: "pending", dependsOn: input.dependsOn ?? [], isolation: input.isolation,
            createdAt: new Date().toISOString(), modifiedFiles: [], ...(input.label ? { label: input.label } : {}),
        };
        this.tasks.set(id, record);
        let markSettled;
        this.settled.set(id, new Promise((resolve) => { markSettled = resolve; }));
        if (input.label) {
            this.labels.set(input.label, id);
            for (const wake of this.labelWaiters.get(input.label) ?? [])
                wake();
            this.labelWaiters.delete(input.label);
        }
        this.update(record, "pending", input.dependsOn?.length ? `waiting for ${input.dependsOn.join(", ")}` : undefined);
        const linked = anySignal(signal, this.controller.signal);
        try {
            const blocker = await this.waitForDependencies(record, linked.signal);
            if (blocker) {
                record.error = blocker;
                this.update(record, "blocked", blocker);
                return record;
            }
            await this.semaphore.use(() => this.run(record, linked.signal), linked.signal);
        }
        catch (error) {
            if (!SETTLED.has(record.status)) {
                record.error = errorMessage(error);
                this.update(record, linked.signal.aborted ? "cancelled" : "failed", record.error);
            }
        }
        finally {
            linked.dispose();
            markSettled();
        }
        return record;
    }
    async run(record, parent) {
        // A referenced timer (unlike AbortSignal.timeout) keeps the process alive while a task waits on its deadline.
        const deadline = new AbortController();
        const timer = setTimeout(() => deadline.abort(new Error("timeout")), this.options.timeoutMs);
        const timeout = deadline.signal;
        const linked = anySignal(parent, timeout);
        record.startedAt = new Date().toISOString();
        this.update(record, "running");
        try {
            await this.options.execute(record, linked.signal);
            if (timeout.aborted) {
                record.error = `Timed out after ${Math.round(this.options.timeoutMs / 1000)}s.`;
                this.update(record, "timed_out", record.error);
            }
            else if (parent.aborted) {
                this.update(record, "cancelled");
            }
            else if (!SETTLED.has(record.status)) {
                this.update(record, record.agentStatus === "completed" ? "completed" : "failed", record.error);
            }
        }
        catch (error) {
            if (timeout.aborted) {
                record.error = `Timed out after ${Math.round(this.options.timeoutMs / 1000)}s.`;
                this.update(record, "timed_out", record.error);
            }
            else if (parent.aborted || error instanceof CancelledError) {
                this.update(record, "cancelled");
            }
            else {
                record.error = errorMessage(error);
                this.update(record, "failed", record.error);
            }
        }
        finally {
            clearTimeout(timer);
            linked.dispose();
        }
    }
    async waitForDependencies(record, signal) {
        for (const label of record.dependsOn) {
            // Ids (t1, t2…) are assigned synchronously, so only labels can still be on their way from a sibling call.
            const id = this.labels.get(label) ?? (this.tasks.has(label) || /^t\d+$/.test(label) ? (this.tasks.has(label) ? label : undefined) : await this.waitForLabel(label, signal));
            if (!id)
                return `Unknown dependency "${label}" (no task with that label or id).`;
            if (id === record.id || this.dependsOnTransitively(id, record.id))
                return `Dependency cycle through "${label}".`;
            await abortable(this.settled.get(id) ?? Promise.resolve(), signal);
            const dependency = this.tasks.get(id);
            if (!SATISFIED.has(dependency.status))
                return `Dependency "${label}" (${id}) ended as ${dependency.status}.`;
        }
        return undefined;
    }
    dependsOnTransitively(from, target, seen = new Set()) {
        if (seen.has(from))
            return false;
        seen.add(from);
        const record = this.tasks.get(from);
        for (const label of record?.dependsOn ?? []) {
            const id = this.labels.get(label) ?? label;
            if (id === target || this.dependsOnTransitively(id, target, seen))
                return true;
        }
        return false;
    }
    waitForLabel(label, signal) {
        return new Promise((resolve) => {
            const done = () => {
                clearTimeout(timer);
                signal.removeEventListener("abort", done);
                resolve(this.labels.get(label));
            };
            const timer = setTimeout(done, LABEL_WAIT_MS);
            signal.addEventListener("abort", done, { once: true });
            const waiters = this.labelWaiters.get(label) ?? [];
            waiters.push(done);
            this.labelWaiters.set(label, waiters);
        });
    }
    cancelAll() {
        this.controller.abort();
    }
    render() {
        const tasks = this.list();
        if (!tasks.length)
            return "No delegated tasks.";
        return tasks.map((task) => [
            `${task.id}${task.label ? ` (${task.label})` : ""} → ${task.agent}: ${task.status}${task.isolation === "worktree" ? " [worktree]" : ""}`,
            `  task: ${oneLine(task.task, 160)}`,
            task.verification ? `  verification: ${task.verification.status} — ${oneLine(task.verification.detail, 200)}` : "",
            task.modifiedFiles.length ? `  files: ${task.modifiedFiles.slice(0, 20).join(", ")}${task.modifiedFiles.length > 20 ? " …" : ""}` : "",
            task.error ? `  error: ${oneLine(task.error, 300)}` : "",
        ].filter(Boolean).join("\n")).join("\n");
    }
}
function abortable(promise, signal) {
    if (signal.aborted)
        return Promise.reject(new CancelledError());
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(new CancelledError());
        signal.addEventListener("abort", onAbort, { once: true });
        promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
}
//# sourceMappingURL=tasks.js.map