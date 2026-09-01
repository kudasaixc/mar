import { ToolRegistry } from "./registry.js";
import type { Workspace } from "./workspace.js";
export declare class SharedNotes {
    private readonly notes;
    set(key: string, author: string, text: string): void;
    render(): string;
}
export declare function addBuiltinTools(registry: ToolRegistry, workspace: Workspace, notes: SharedNotes): ToolRegistry;
//# sourceMappingURL=builtins.d.ts.map