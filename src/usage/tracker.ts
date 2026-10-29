import { BudgetExceededError } from "../errors.js";
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

const empty = (): Omit<Row, "agent" | "model"> => ({
  requests: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, estimatedRequests: 0,
});

/**
 * Per-agent and per-model usage accounting with configurable pricing. Costs are
 * estimates computed from user-supplied prices, never billing data.
 */
export class UsageTracker {
  private readonly rows = new Map<string, Row>();
  private readonly started = Date.now();

  constructor(private readonly pricing: Record<string, Pricing> = {}, private readonly budgets: BudgetSettings = {}) {}

  record(agent: string, model: string, usage: Usage | undefined, estimate: { input: number; output: number }): void {
    const key = `${agent}\u0000${model}`;
    let row = this.rows.get(key);
    if (!row) this.rows.set(key, row = { agent, model, ...empty() });
    const exact = usage?.inputTokens !== undefined && usage.outputTokens !== undefined;
    row.requests += 1;
    if (!exact) row.estimatedRequests += 1;
    row.inputTokens += usage?.inputTokens ?? estimate.input;
    row.outputTokens += usage?.outputTokens ?? estimate.output;
    row.cachedInputTokens += usage?.cachedInputTokens ?? 0;
    row.cacheWriteTokens += usage?.cacheWriteTokens ?? 0;
    row.reasoningTokens += usage?.reasoningTokens ?? 0;
  }

  priceFor(model: string): Pricing | undefined {
    const provider = model.split("/")[0];
    return this.pricing[model] ?? (provider ? this.pricing[`${provider}/*`] : undefined);
  }

  static cost(row: Omit<Row, "agent" | "model">, price: Pricing): number {
    const cached = row.cachedInputTokens;
    const writes = row.cacheWriteTokens;
    const uncached = Math.max(0, row.inputTokens - cached - writes);
    return (uncached * price.input + cached * (price.cachedInput ?? price.input) + writes * (price.cacheWrite ?? price.input) + row.outputTokens * price.output) / 1_000_000;
  }

  totals(filter?: (row: Row) => boolean): UsageTotals {
    const total = empty();
    let cost = 0;
    const unpriced = new Set<string>();
    for (const row of this.rows.values()) {
      if (filter && !filter(row)) continue;
      for (const key of Object.keys(total) as Array<keyof typeof total>) total[key] += row[key];
      const price = this.priceFor(row.model);
      if (price) cost += UsageTracker.cost(row, price);
      else unpriced.add(row.model);
    }
    return { ...total, costUsd: unpriced.size ? undefined : cost, unpricedModels: [...unpriced] };
  }

  byAgent(): Array<{ agent: string; totals: UsageTotals }> {
    const agents = [...new Set([...this.rows.values()].map((row) => row.agent))];
    return agents.map((agent) => ({ agent, totals: this.totals((row) => row.agent === agent) }));
  }

  /** Partial cost over priced models only (useful when some models are unpriced). */
  pricedCost(): number {
    let cost = 0;
    for (const row of this.rows.values()) {
      const price = this.priceFor(row.model);
      if (price) cost += UsageTracker.cost(row, price);
    }
    return cost;
  }

  /** Throws BudgetExceededError when a configured session budget has been reached. */
  checkBudget(): void {
    const totals = this.totals();
    const { maxTokens, maxCostUsd, maxRuntimeMs } = this.budgets;
    if (maxTokens !== undefined && totals.inputTokens + totals.outputTokens >= maxTokens) {
      throw new BudgetExceededError(`Token budget reached (${totals.inputTokens + totals.outputTokens} ≥ ${maxTokens}).`);
    }
    if (maxCostUsd !== undefined && this.pricedCost() >= maxCostUsd) {
      throw new BudgetExceededError(`Estimated cost budget reached ($${this.pricedCost().toFixed(4)} ≥ $${maxCostUsd}).`);
    }
    if (maxRuntimeMs !== undefined && Date.now() - this.started >= maxRuntimeMs) {
      throw new BudgetExceededError(`Runtime budget reached (${Math.round((Date.now() - this.started) / 1000)}s).`);
    }
  }

  toJSON(): Row[] {
    return [...this.rows.values()];
  }

  restore(rows: unknown): void {
    if (!Array.isArray(rows)) return;
    for (const row of rows as Row[]) {
      if (typeof row?.agent !== "string" || typeof row.model !== "string") continue;
      this.rows.set(`${row.agent}\u0000${row.model}`, { ...empty(), ...row });
    }
  }

  format(): string {
    const lines: string[] = [];
    const describe = (totals: UsageTotals): string => {
      const cache = totals.cachedInputTokens || totals.cacheWriteTokens ? ` (cache read ${totals.cachedInputTokens}, write ${totals.cacheWriteTokens})` : "";
      const estimated = totals.estimatedRequests ? `, ${totals.estimatedRequests} estimated` : "";
      const cost = totals.costUsd !== undefined ? ` · ~$${totals.costUsd.toFixed(4)} est.` : "";
      return `${totals.requests} req${estimated} · in ${totals.inputTokens}${cache} · out ${totals.outputTokens}${cost}`;
    };
    for (const { agent, totals } of this.byAgent()) lines.push(`${agent.padEnd(18)} ${describe(totals)}`);
    const total = this.totals();
    lines.push(`${"total".padEnd(18)} ${describe(total)}`);
    if (total.unpricedModels.length) lines.push(`No pricing configured for: ${total.unpricedModels.join(", ")} (set "pricing" in config for cost estimates).`);
    return lines.join("\n");
  }
}
