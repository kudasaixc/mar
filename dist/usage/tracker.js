import { BudgetExceededError } from "../errors.js";
const empty = () => ({
    requests: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, estimatedRequests: 0,
});
/**
 * Per-agent and per-model usage accounting with configurable pricing. Costs are
 * estimates computed from user-supplied prices, never billing data.
 */
export class UsageTracker {
    pricing;
    budgets;
    rows = new Map();
    started = Date.now();
    constructor(pricing = {}, budgets = {}) {
        this.pricing = pricing;
        this.budgets = budgets;
    }
    record(agent, model, usage, estimate) {
        const key = `${agent}\u0000${model}`;
        let row = this.rows.get(key);
        if (!row)
            this.rows.set(key, row = { agent, model, ...empty() });
        const exact = usage?.inputTokens !== undefined && usage.outputTokens !== undefined;
        row.requests += 1;
        if (!exact)
            row.estimatedRequests += 1;
        row.inputTokens += usage?.inputTokens ?? estimate.input;
        row.outputTokens += usage?.outputTokens ?? estimate.output;
        row.cachedInputTokens += usage?.cachedInputTokens ?? 0;
        row.cacheWriteTokens += usage?.cacheWriteTokens ?? 0;
        row.reasoningTokens += usage?.reasoningTokens ?? 0;
    }
    priceFor(model) {
        const provider = model.split("/")[0];
        return this.pricing[model] ?? (provider ? this.pricing[`${provider}/*`] : undefined);
    }
    static cost(row, price) {
        const cached = row.cachedInputTokens;
        const writes = row.cacheWriteTokens;
        const uncached = Math.max(0, row.inputTokens - cached - writes);
        return (uncached * price.input + cached * (price.cachedInput ?? price.input) + writes * (price.cacheWrite ?? price.input) + row.outputTokens * price.output) / 1_000_000;
    }
    totals(filter) {
        const total = empty();
        let cost = 0;
        const unpriced = new Set();
        for (const row of this.rows.values()) {
            if (filter && !filter(row))
                continue;
            for (const key of Object.keys(total))
                total[key] += row[key];
            const price = this.priceFor(row.model);
            if (price)
                cost += UsageTracker.cost(row, price);
            else
                unpriced.add(row.model);
        }
        return { ...total, costUsd: unpriced.size ? undefined : cost, unpricedModels: [...unpriced] };
    }
    byAgent() {
        const agents = [...new Set([...this.rows.values()].map((row) => row.agent))];
        return agents.map((agent) => ({ agent, totals: this.totals((row) => row.agent === agent) }));
    }
    /** Partial cost over priced models only (useful when some models are unpriced). */
    pricedCost() {
        let cost = 0;
        for (const row of this.rows.values()) {
            const price = this.priceFor(row.model);
            if (price)
                cost += UsageTracker.cost(row, price);
        }
        return cost;
    }
    /** Throws BudgetExceededError when a configured session budget has been reached. */
    checkBudget() {
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
    toJSON() {
        return [...this.rows.values()];
    }
    restore(rows) {
        if (!Array.isArray(rows))
            return;
        for (const row of rows) {
            if (typeof row?.agent !== "string" || typeof row.model !== "string")
                continue;
            this.rows.set(`${row.agent}\u0000${row.model}`, { ...empty(), ...row });
        }
    }
    format() {
        const lines = [];
        const describe = (totals) => {
            const cache = totals.cachedInputTokens || totals.cacheWriteTokens ? ` (cache read ${totals.cachedInputTokens}, write ${totals.cacheWriteTokens})` : "";
            const estimated = totals.estimatedRequests ? `, ${totals.estimatedRequests} estimated` : "";
            const cost = totals.costUsd !== undefined ? ` · ~$${totals.costUsd.toFixed(4)} est.` : "";
            return `${totals.requests} req${estimated} · in ${totals.inputTokens}${cache} · out ${totals.outputTokens}${cost}`;
        };
        for (const { agent, totals } of this.byAgent())
            lines.push(`${agent.padEnd(18)} ${describe(totals)}`);
        const total = this.totals();
        lines.push(`${"total".padEnd(18)} ${describe(total)}`);
        if (total.unpricedModels.length)
            lines.push(`No pricing configured for: ${total.unpricedModels.join(", ")} (set "pricing" in config for cost estimates).`);
        return lines.join("\n");
    }
}
//# sourceMappingURL=tracker.js.map