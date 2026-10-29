import type { MarConfig } from "./types.js";
export declare const GLOBAL_CONFIG_PATH: string;
export declare const CONFIG_VERSION = 2;
/** Safe read-only commands that never need a prompt outside read-only mode. */
export declare const DEFAULT_ALLOW_COMMANDS: string[];
export declare const DEFAULT_DENY_COMMANDS: string[];
export declare function defaultRuntime(): MarConfig["runtime"];
export declare function defaultConfig(): MarConfig;
/**
 * Upgrade older configuration documents in memory. Version 1 files remain valid:
 * every new field receives its default. The file on disk is only rewritten by
 * `mar config migrate`.
 */
export declare function migrateConfig(value: unknown): {
    config: Record<string, unknown>;
    migratedFrom?: number;
};
export declare function validateConfig(input: unknown): MarConfig;
export declare function findProjectConfig(workspace: string): Promise<string | undefined>;
export interface LoadedConfig {
    config: MarConfig;
    paths: string[];
    /** Files that use an older schema version and were migrated in memory. */
    migrated: string[];
}
export declare function loadConfig(workspace?: string, explicitPath?: string): Promise<LoadedConfig>;
export declare function saveConfig(config: MarConfig, path?: string): Promise<void>;
/** Rewrite a configuration file in the current schema, keeping a `.bak` copy. */
export declare function migrateConfigFile(path?: string): Promise<{
    from?: number;
    backup?: string;
}>;
export declare function hasConfig(): Promise<boolean>;
//# sourceMappingURL=config.d.ts.map