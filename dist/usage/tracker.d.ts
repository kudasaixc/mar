import type { BudgetSettings, Pricing, Usage } from "../types.js";
export interface UsageTotals {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    /** Requests whose usage was estimated because the provider reported none. */
    estimatedRequests: number;
    /** Estimated USD cost; undefined when no pricing is configured for some model used. */
    costUsd: number | undefined;
    unpricedModels: string[];
}
interface Row extends Omit<UsageTotals, "costUsd" | "unpricedModels"> {
    agent: string;
    model: string;
}
/**
 * Per-agent and per-model usage accounting with configurable pricing. Costs are
 * estimates computed from user-supplied prices, never billing data.
 */
export declare class UsageTracker {
    private readonly pricing;
    private readonly budgets;
    private readonly rows;
    private readonly started;
    constructor(pricing?: Record<string, Pricing>, budgets?: BudgetSettings);
    record(agent: string, model: string, usage: Usage | undefined, estimate: {
        input: number;
        output: number;
    }): void;
    priceFor(model: string): Pricing | undefined;
    static cost(row: Omit<Row, "agent" | "model">, price: Pricing): number;
    totals(filter?: (row: Row) => boolean): UsageTotals;
    byAgent(): Array<{
        agent: string;
        totals: UsageTotals;
    }>;
    /** Partial cost over priced models only (useful when some models are unpriced). */
    pricedCost(): number;
    /** Throws BudgetExceededError when a configured session budget has been reached. */
    checkBudget(): void;
    toJSON(): Row[];
    restore(rows: unknown): void;
    format(): string;
}
export {};
//# sourceMappingURL=tracker.d.ts.map