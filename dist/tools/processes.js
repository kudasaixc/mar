import { ToolError } from "../errors.js";
import { BoundedBuffer } from "../util/text.js";
/**
 * Long-running processes (dev servers, watchers) started by agents. Output is
 * bounded, every process is killed with its tree on stop/session end, and the
 * number of concurrent processes is capped.
 */
export class ProcessManager {
    maxProcesses;
    processes = new Map();
    counter = 0;
    constructor(maxProcesses = 8) {
        this.maxProcesses = maxProcesses;
    }
    start(workspace, spec, agent) {
        const running = [...this.processes.values()].filter((process) => !process.result);
        if (running.length >= this.maxProcesses)
            throw new ToolError(`At most ${this.maxProcesses} background processes may run; stop one first.`);
        const id = `p${++this.counter}`;
        const controller = new AbortController();
        const output = new BoundedBuffer(200_000);
        const command = spec.argv ? spec.argv.join(" ") : spec.command ?? "";
        const managed = {
            id, command, agent, startedAt: Date.now(), output, cursor: 0, controller,
            done: Promise.resolve(undefined),
        };
        managed.done = workspace.execStreaming(spec, controller.signal, (chunk) => output.push(chunk)).then((result) => {
            managed.result = result;
            return result;
        });
        this.processes.set(id, managed);
        return id;
    }
    async output(id, waitMs = 0) {
        const managed = this.get(id);
        if (waitMs > 0 && !managed.result)
            await Promise.race([managed.done, new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 30_000)))]);
        const text = managed.output.toString();
        const fresh = managed.output.truncated ? text : text.slice(managed.cursor);
        managed.cursor = text.length;
        const status = managed.result
            ? `exited (${managed.result.exitCode ?? managed.result.signal ?? "unknown"})`
            : `running for ${Math.round((Date.now() - managed.startedAt) / 1000)}s`;
        return `${id} ${status}: ${managed.command}\n${fresh.slice(-20_000) || "(no new output)"}`;
    }
    async stop(id) {
        const managed = this.get(id);
        if (!managed.result) {
            managed.controller.abort();
            await managed.done;
        }
        return `Stopped ${id} (${managed.command}).`;
    }
    list() {
        if (!this.processes.size)
            return "No background processes.";
        return [...this.processes.values()].map((process) => `${process.id} [${process.result ? "exited" : "running"}] ${process.agent}: ${process.command}`).join("\n");
    }
    async stopAll() {
        for (const managed of this.processes.values())
            if (!managed.result)
                managed.controller.abort();
        await Promise.allSettled([...this.processes.values()].map((managed) => managed.done));
    }
    get(id) {
        const managed = this.processes.get(id);
        if (!managed)
            throw new ToolError(`Unknown process "${id}". ${this.list()}`);
        return managed;
    }
}
//# sourceMappingURL=processes.js.map