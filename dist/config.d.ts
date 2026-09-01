import type { MarConfig } from "./types.js";
export declare const GLOBAL_CONFIG_PATH: string;
export declare function defaultConfig(): MarConfig;
export declare function validateConfig(value: unknown): MarConfig;
export declare function findProjectConfig(workspace: string): Promise<string | undefined>;
export declare function loadConfig(workspace?: string, explicitPath?: string): Promise<{
    config: MarConfig;
    paths: string[];
}>;
export declare function saveConfig(config: MarConfig, path?: string): Promise<void>;
export declare function hasConfig(): Promise<boolean>;
//# sourceMappingURL=config.d.ts.map