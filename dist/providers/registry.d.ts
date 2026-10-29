import type { MarConfig, ModelAdapter, ModelCapabilities } from "../types.js";
export declare class ProviderRegistry {
    private readonly adapters;
    private readonly configs;
    private constructor();
    static create(config: MarConfig): Promise<ProviderRegistry>;
    private createAdapter;
    get(id: string): ModelAdapter;
    /** Effective capabilities: built-in hints < adapter hints < provider config < agent config. */
    capabilities(id: string, model: string, override?: Partial<ModelCapabilities>): ModelCapabilities;
    /** Whether streaming is enabled for this provider (plugins stream only if they declare it). */
    streams(id: string): boolean;
    entries(): [string, ModelAdapter][];
}
//# sourceMappingURL=registry.d.ts.map