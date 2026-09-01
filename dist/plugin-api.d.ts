import type { ModelAdapter, ProviderConfig } from "./types.js";
import type { ToolDefinition } from "./tools/types.js";
export type { AgentProfile, ChatMessage, CompletionRequest, CompletionResponse, JsonSchema, MarConfig, ModelAdapter, ProviderConfig, ToolCall, ToolSpec, } from "./types.js";
export interface ProviderPluginContext {
    providerId: string;
    config: ProviderConfig;
    env: NodeJS.ProcessEnv;
    fetch: typeof globalThis.fetch;
}
export interface ProviderPlugin {
    apiVersion: 1;
    createProvider(context: ProviderPluginContext): ModelAdapter | Promise<ModelAdapter>;
}
export interface ToolPluginContext {
    /** Absolute path of the workspace selected by the user. */
    workspace: string;
}
export interface MarToolPlugin {
    apiVersion: 1;
    tools(context: ToolPluginContext): ToolDefinition[] | Promise<ToolDefinition[]>;
}
export declare function defineProviderPlugin(plugin: ProviderPlugin): ProviderPlugin;
export declare function defineToolPlugin(plugin: MarToolPlugin): MarToolPlugin;
export type { ToolContext, ToolDefinition, ToolResult } from "./tools/types.js";
//# sourceMappingURL=plugin-api.d.ts.map