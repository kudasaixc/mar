import { type TaskState } from "../context/task-state.js";
import type { MemoryStore } from "../memory/store.js";
import { type ToolRegistry } from "./registry.js";
import type { ProcessManager } from "./processes.js";
import type { ToolDefinition } from "./types.js";
import { type Workspace } from "./workspace.js";
export interface BuiltinContext {
    workspace: Workspace;
    memory: MemoryStore;
    /** The calling agent's task state (plan/decisions). */
    taskState: TaskState;
    processes: ProcessManager;
    /** Named verification commands available to run_check. */
    checks: Record<string, string>;
}
export declare function builtinTools(context: BuiltinContext): ToolDefinition[];
export declare function addBuiltinTools(registry: ToolRegistry, context: BuiltinContext): ToolRegistry;
//# sourceMappingURL=builtins.d.ts.map