import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { ProviderError } from "../errors.js";
import { AgentRuntime, DEFAULT_AGENT_SETTINGS } from "../runtime/agent.js";
import { ToolRegistry } from "../tools/registry.js";
import type { ChatMessage, CompletionRequest, CompletionResponse, ModelAdapter, RuntimeEvent } from "../types.js";
import { UsageTracker } from "../usage/tracker.js";
import { registryFor, toolResults } from "./helpers.js";

const fast = { ...DEFAULT_AGENT_SETTINGS, retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5 } };
afterEach(() => undefined);

function adapter(complete: (request: CompletionRequest) => Promise<CompletionResponse> | CompletionResponse): ModelAdapter {
  return { id: "fake", complete: async (request) => complete(request) };
}

function tools(counter: { runs: number }, options: { fail?: boolean; delayMs?: number } = {}): ToolRegistry {
  return new ToolRegistry("never", async () => true).add({
    spec: { name: "act", description: "side effect", parameters: { type: "object", properties: { n: { type: "number" } } } },
    mutating: true,
    permission: "write",
    execute: async (_args, context) => {
      counter.runs += 1;
      if (options.delayMs) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, options.delayMs);
          context.signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
        });
        if (context.signal?.aborted) return { ok: false, output: "cancelled", meta: { cancelled: true } };
      }
      return options.fail ? { ok: false, output: "boom" } : { ok: true, output: "done" };
    },
  });
}

function agent(model: ModelAdapter | Record<string, ModelAdapter>, registry: ToolRegistry, extra: Partial<ConstructorParameters<typeof AgentRuntime>[0]> = {}, events: RuntimeEvent[] = []) {
  return new AgentRuntime({
    profile: { name: "master", description: "test", provider: "fake", model: "m", maxTurns: 8 },
    providers: registryFor("complete" in model ? { fake: model as ModelAdapter } : model as Record<string, ModelAdapter>),
    tools: registry,
    workspace: "/tmp",
    teamContext: "",
    onEvent: (event) => events.push(event),
    settings: fast,
    ...extra,
  });
}

test("transient provider errors are retried without replaying executed tools", async () => {
  const counter = { runs: 0 };
  let requests = 0;
  const model = adapter((request) => {
    requests += 1;
    if (requests === 1) return { content: "", toolCalls: [{ id: "a1", name: "act", arguments: { n: 1 } }] };
    if (requests === 2) throw new ProviderError("upstream 503", 503);
    if (requests === 3) throw new ProviderError("rate limited", 429, undefined, undefined, 1);
    assert.equal(toolResults(request).length, 1);
    return { content: "finished", toolCalls: [] };
  });
  const events: RuntimeEvent[] = [];
  const result = await agent(model, tools(counter), {}, events).runDetailed("go");
  assert.equal(result.status, "completed");
  assert.equal(counter.runs, 1, "the tool ran exactly once");
  assert.equal(requests, 4);
  assert.equal(events.filter((event) => event.type === "agent:retry").length, 2);
});

test("non-retryable failures move to the fallback model", async () => {
  const counter = { runs: 0 };
  const primary = adapter(() => { throw new ProviderError("bad key", 401); });
  const backup = adapter(() => ({ content: "from backup", toolCalls: [] }));
  const events: RuntimeEvent[] = [];
  const runtime = new AgentRuntime({
    profile: { name: "master", description: "t", provider: "primary", model: "a", fallbacks: [{ provider: "backup", model: "b" }] },
    providers: registryFor({ primary, backup }), tools: tools(counter), workspace: "/tmp", teamContext: "",
    onEvent: (event) => events.push(event), settings: fast,
  });
  assert.equal(await runtime.run("x"), "from backup");
  assert.ok(events.some((event) => event.type === "agent:fallback"));
});

test("identical failing calls are refused after three attempts", async () => {
  const counter = { runs: 0 };
  let requests = 0;
  const model = adapter(() => {
    requests += 1;
    return requests <= 5 ? { content: "", toolCalls: [{ id: `c${requests}`, name: "act", arguments: { n: 1 } }] } : { content: "gave up", toolCalls: [] };
  });
  const runtime = agent(model, tools(counter, { fail: true }));
  const result = await runtime.runDetailed("x");
  assert.equal(result.status, "completed");
  assert.equal(counter.runs, 3, "the 4th and 5th identical calls were not executed");
  const refused = runtime.history().filter((message) => message.role === "tool" && /already failed 3 times/.test(message.content));
  assert.equal(refused.length, 2);
  assert.ok(runtime.history().filter((message) => message.role === "tool").every((message) => message.isError));
});

test("cancellation stops the run, cancels the running tool, and keeps the history valid", async () => {
  const counter = { runs: 0 };
  const model = adapter(() => ({
    content: "", toolCalls: [{ id: "x1", name: "act", arguments: { n: 1 } }, { id: "x2", name: "act", arguments: { n: 2 } }],
  }));
  const runtime = agent(model, tools(counter, { delayMs: 5_000 }));
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const started = Date.now();
  const result = await runtime.runDetailed("x", controller.signal);
  assert.equal(result.status, "cancelled");
  assert.ok(Date.now() - started < 2_000);
  assert.equal(counter.runs, 1, "the second call never started");
  const results = runtime.history().filter((message) => message.role === "tool");
  assert.deepEqual(results.map((message) => message.toolCallId), ["x1", "x2"]);
  assert.equal(results[1]!.meta?.synthetic, "not-started");
  await assert.rejects(runtime.run("again", AbortSignal.abort()), /Cancel/i);
});

test("provider context overflow triggers compaction and a single retry", async () => {
  const counter = { runs: 0 };
  let requests = 0;
  let sizes: number[] = [];
  const model = adapter((request) => {
    requests += 1;
    sizes.push(request.messages.length);
    if (requests <= 6) return { content: "", toolCalls: [{ id: `r${requests}`, name: "act", arguments: { n: requests } }] };
    if (requests === 7) throw new ProviderError("This model's maximum context length is 8192 tokens", 400);
    return { content: "fits now", toolCalls: [] };
  });
  const events: RuntimeEvent[] = [];
  const runtime = agent(model, tools(counter), { profile: { name: "master", description: "t", provider: "fake", model: "m", maxTurns: 10 } }, events);
  const result = await runtime.runDetailed("x");
  assert.equal(result.status, "completed");
  assert.ok(events.some((event) => event.type === "agent:compaction"));
  // sizes[6] overflowed; sizes[7] is the summarizer request; the retry is the last one.
  assert.equal(sizes.length, 9);
  assert.ok(sizes.at(-1)! < sizes[6]!, "the retried request is smaller");
  assert.ok(runtime.history().some((message) => message.meta?.summary && /x/.test(message.content)), "the instruction survives in the summary");
  sizes = [];
});

test("max turns and budgets end the run with an explicit status", async () => {
  const counter = { runs: 0 };
  let n = 0;
  const looping = adapter(() => ({ content: "", toolCalls: [{ id: `l${++n}`, name: "act", arguments: { n } }] }));
  const limited = agent(looping, tools(counter), { profile: { name: "master", description: "t", provider: "fake", model: "m", maxTurns: 3 } });
  const result = await limited.runDetailed("x");
  assert.equal(result.status, "max_turns");
  assert.equal(result.turns, 3);
  assert.equal(result.verification.status, "unverified", "writes happened but nothing was checked");

  const usage = new UsageTracker({}, { maxTokens: 50 });
  const spendy = adapter(() => ({ content: "", toolCalls: [{ id: `b${++n}`, name: "act", arguments: { n } }], usage: { inputTokens: 40, outputTokens: 20 } }));
  const budgeted = await agent(spendy, tools(counter), { usage }).runDetailed("x");
  assert.equal(budgeted.status, "budget_exceeded");
  assert.match(budgeted.output, /Token budget/);
});

test("streaming deltas are emitted and final text is marked as streamed", async () => {
  const counter = { runs: 0 };
  const model = adapter((request) => {
    request.onDelta?.({ type: "text", text: "Hel" });
    request.onDelta?.({ type: "text", text: "lo" });
    return { content: "Hello", toolCalls: [] };
  });
  const events: RuntimeEvent[] = [];
  await agent(model, tools(counter), {}, events).run("x");
  assert.deepEqual(events.filter((event) => event.type === "agent:delta").map((event) => (event as { text: string }).text), ["Hel", "lo"]);
  const text = events.find((event) => event.type === "agent:text") as Extract<RuntimeEvent, { type: "agent:text" }>;
  assert.equal(text.streamed, true);
});

test("usage is recorded per agent with cached tokens kept separate", async () => {
  const counter = { runs: 0 };
  const usage = new UsageTracker({ "fake/*": { input: 1, output: 2, cachedInput: 0.1 } });
  const model = adapter(() => ({ content: "ok", toolCalls: [], usage: { inputTokens: 1_000_000, outputTokens: 500_000, cachedInputTokens: 800_000 } }));
  await agent(model, tools(counter), { usage }).run("x");
  const totals = usage.totals();
  assert.equal(totals.inputTokens, 1_000_000);
  assert.equal(totals.cachedInputTokens, 800_000);
  // 200k uncached × $1/M + 800k cached × $0.1/M + 500k output × $2/M = 0.2 + 0.08 + 1.0
  assert.ok(Math.abs((totals.costUsd ?? 0) - 1.28) < 1e-9, `cost ${totals.costUsd}`);
  assert.equal(usage.byAgent()[0]!.agent, "master");
});

test("restore keeps the current system prompt and repaired history", () => {
  const counter = { runs: 0 };
  const runtime = agent(adapter(() => ({ content: "", toolCalls: [] })), tools(counter));
  const old: ChatMessage[] = [{ role: "system", content: "OLD PROMPT" }, { role: "user", content: "earlier" }, { role: "assistant", content: "earlier answer" }];
  runtime.restore(old);
  assert.notEqual(runtime.history()[0]!.content, "OLD PROMPT");
  assert.deepEqual(runtime.history().slice(1).map((message) => message.content), ["earlier", "earlier answer"]);
});
