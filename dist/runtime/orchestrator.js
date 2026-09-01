import { ProviderRegistry } from "../providers/registry.js";
import { loadToolPlugins } from "../plugins.js";
import { addBuiltinTools, SharedNotes } from "../tools/builtins.js";
import { ToolRegistry } from "../tools/registry.js";
import { Workspace } from "../tools/workspace.js";
import { AgentRuntime } from "./agent.js";
export class Orchestrator {
    workspace;
    master;
    workers;
    notes;
    constructor(workspace, master, workers, notes) {
        this.workspace = workspace;
        this.master = master;
        this.workers = workers;
        this.notes = notes;
    }
    static async create(options) {
        const { config } = options;
        const workspace = await Workspace.create(options.workspace, config.runtime.maxToolOutput, config.runtime.commandTimeoutMs);
        const providers = await ProviderRegistry.create(config);
        const notes = new SharedNotes();
        const pluginTools = await loadToolPlugins(config.runtime.plugins, workspace.root);
        const onEvent = options.onEvent ?? (() => undefined);
        const approval = options.readOnly ? "read-only" : options.autoApprove ? "never" : config.runtime.approval;
        const teamSummary = config.team.workers.length
            ? `Team members:\n${config.team.workers.map((agent) => `- ${agent.name}: ${agent.description} (${agent.provider}/${agent.model})`).join("\n")}`
            : "You are currently the only configured agent.";
        const workers = new Map();
        for (const profile of config.team.workers) {
            const registry = addBuiltinTools(new ToolRegistry(approval, options.approve), workspace, notes);
            for (const tool of pluginTools)
                registry.add(tool);
            workers.set(profile.name, new AgentRuntime({
                profile,
                providers,
                tools: registry,
                workspace: workspace.root,
                teamContext: `${teamSummary}\nYou are a worker. Complete delegated tasks directly in the shared workspace and report verified results.`,
                onEvent,
            }));
        }
        const masterRegistry = addBuiltinTools(new ToolRegistry(approval, options.approve), workspace, notes);
        for (const tool of pluginTools)
            masterRegistry.add(tool);
        if (workers.size)
            masterRegistry.add(delegateTool(workers));
        const master = new AgentRuntime({
            profile: config.team.master,
            providers,
            tools: masterRegistry,
            workspace: workspace.root,
            teamContext: `${teamSummary}\nYou are the master. Decompose work, delegate parallelizable specialties, integrate changes, and perform final verification. Multiple delegate calls in one response run concurrently.`,
            onEvent,
        });
        return new Orchestrator(workspace, master, workers, notes);
    }
    run(task) {
        return this.master.run(task);
    }
    reset() {
        this.master.reset();
        for (const worker of this.workers.values())
            worker.reset();
    }
    teamStatus() {
        return [this.master.profile, ...[...this.workers.values()].map((worker) => worker.profile)]
            .map((agent, index) => `${index === 0 ? "master" : "worker"}  ${agent.name}  ${agent.provider}/${agent.model}`)
            .join("\n");
    }
    sharedNotes() {
        return this.notes.render();
    }
}
function delegateTool(workers) {
    return {
        spec: {
            name: "delegate",
            description: "Delegate a self-contained task to a configured worker. Emit multiple delegate calls together to run independent work concurrently.",
            parameters: {
                type: "object",
                properties: {
                    agent: { type: "string", enum: [...workers.keys()] },
                    task: { type: "string", description: "Precise objective, scope, constraints, and expected verification." },
                },
                required: ["agent", "task"],
                additionalProperties: false,
            },
        },
        mutating: false,
        execute: async (args) => {
            const name = typeof args.agent === "string" ? args.agent : "";
            const task = typeof args.task === "string" ? args.task : "";
            const worker = workers.get(name);
            if (!worker)
                return { ok: false, output: `Unknown worker "${name}". Available: ${[...workers.keys()].join(", ")}` };
            if (!task)
                return { ok: false, output: "Delegated task cannot be empty." };
            try {
                const output = await worker.run(task);
                return { ok: true, output: `${name} completed the delegation:\n${output}` };
            }
            catch (error) {
                return { ok: false, output: `${name} failed: ${error instanceof Error ? error.message : String(error)}` };
            }
        },
    };
}
//# sourceMappingURL=orchestrator.js.map