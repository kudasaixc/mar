import type { MarConfig, ModelAdapter } from "../types.js";
export declare class ProviderRegistry {
    private readonly adapters;
    private constructor();
    static create(config: MarConfig): Promise<ProviderRegistry>;
    private createAdapter;
    get(id: string): ModelAdapter;
    entries(): [string, ModelAdapter][];
}
//# sourceMappingURL=registry.d.ts.map