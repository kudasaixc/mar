import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { ProviderError } from "../errors.js";
import { mapMessages } from "../providers/anthropic.js";
import { AnthropicAdapter } from "../providers/anthropic.js";
import { GeminiAdapter, sanitizeSchema } from "../providers/gemini.js";
import { OllamaAdapter } from "../providers/ollama.js";
import { OpenAICompatibleAdapter } from "../providers/openai-compatible.js";
import { backoffDelay, withRetry } from "../providers/retry.js";
import type { ChatMessage, CompletionRequest, StreamDelta } from "../types.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.TEST_API_KEY;
});

function streamingFetch(chunks: string[], contentType: string, inspect?: (body: any, url: string) => void): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    inspect?.(JSON.parse(String(init?.body ?? "{}")), String(input));
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        // Split chunks at awkward boundaries to exercise the line buffering.
        for (const chunk of chunks) {
          const middle = Math.floor(chunk.length / 2);
          controller.enqueue(encoder.encode(chunk.slice(0, middle)));
          controller.enqueue(encoder.encode(chunk.slice(middle)));
        }
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": contentType } });
  }) as typeof fetch;
}

function errorFetch(status: number, body: string, headers: Record<string, string> = {}): void {
  globalThis.fetch = (async () => new Response(body, { status, headers: { "content-type": "application/json", ...headers } })) as typeof fetch;
}

const sse = (events: unknown[]): string[] => events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`);

function request(deltas: StreamDelta[]): CompletionRequest {
  return {
    model: "m",
    messages: [{ role: "system", content: "s" }, { role: "user", content: "hi" }],
    tools: [{ name: "read_file", description: "r", parameters: { type: "object", properties: { path: { type: "string" } }, additionalProperties: false } }],
    onDelta: (delta) => deltas.push(delta),
  };
}

test("OpenAI-compatible SSE stream assembles text, tool calls, and usage", async () => {
  process.env.TEST_API_KEY = "k";
  let sent: any;
  streamingFetch(sse([
    { choices: [{ delta: { content: "Hel" } }] },
    { choices: [{ delta: { content: "lo" } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_file", arguments: "{\"pa" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "th\":\"a.ts\"}" } }] }, finish_reason: "tool_calls" }] },
    { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 60 } } },
    "[DONE]",
  ]), "text/event-stream", (body) => { sent = body; });
  const deltas: StreamDelta[] = [];
  const adapter = new OpenAICompatibleAdapter("openai", { kind: "openai-compatible", baseUrl: "https://api.openai.com/v1", apiKeyEnv: "TEST_API_KEY" });
  const response = await adapter.complete(request(deltas));
  assert.equal(sent.stream, true);
  assert.deepEqual(sent.stream_options, { include_usage: true });
  assert.equal(response.content, "Hello");
  assert.deepEqual(response.toolCalls, [{ id: "call_1", name: "read_file", arguments: { path: "a.ts" } }]);
  assert.deepEqual(response.usage, { inputTokens: 100, outputTokens: 20, cachedInputTokens: 60 });
  assert.deepEqual(deltas.filter((delta) => delta.type === "text").map((delta) => (delta as { text: string }).text), ["Hel", "lo"]);
});

test("OpenAI-compatible adapter accepts a JSON body when the server ignores stream", async () => {
  streamingFetch([JSON.stringify({ choices: [{ message: { content: "plain" }, finish_reason: "stop" }] })], "application/json");
  const deltas: StreamDelta[] = [];
  const adapter = new OpenAICompatibleAdapter("local", { kind: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1" });
  assert.equal((await adapter.complete(request(deltas))).content, "plain");
});

test("Anthropic SSE stream handles text, thinking signatures, tool input deltas, and cache usage", async () => {
  process.env.TEST_API_KEY = "k";
  streamingFetch([
    "event: message_start\n" + sse([{ type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 80, cache_creation_input_tokens: 5 } } }])[0]!,
    ...sse([
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "let me think" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig123" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Reading." } },
      { type: "content_block_stop", index: 1 },
      { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_1", name: "read_file", input: {} } },
      { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{\"path\":" } },
      { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "\"b.ts\"}" } },
      { type: "content_block_stop", index: 2 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 33 } },
      { type: "message_stop" },
    ]),
  ], "text/event-stream");
  const deltas: StreamDelta[] = [];
  const adapter = new AnthropicAdapter("anthropic", { kind: "anthropic", apiKeyEnv: "TEST_API_KEY" });
  const response = await adapter.complete(request(deltas));
  assert.equal(response.content, "Reading.");
  assert.deepEqual(response.toolCalls, [{ id: "toolu_1", name: "read_file", arguments: { path: "b.ts" } }]);
  assert.equal(response.usage?.inputTokens, 95, "input includes cache reads and writes");
  assert.equal(response.usage?.cachedInputTokens, 80);
  assert.equal(response.usage?.cacheWriteTokens, 5);
  assert.equal(response.usage?.outputTokens, 33);
  assert.ok(response.reasoning?.length, "thinking blocks are kept for replay");
  assert.ok(deltas.some((delta) => delta.type === "reasoning"));
});

test("Anthropic message mapping keeps tool pairing, errors, and thinking replay", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "go" },
    { role: "assistant", content: "", reasoning: [{ provider: "anthropic", data: { type: "thinking", thinking: "t", signature: "s" } }], toolCalls: [{ id: "a", name: "read_file", arguments: {} }, { id: "b", name: "read_file", arguments: {} }] },
    { role: "tool", toolCallId: "a", content: "ok" },
    { role: "tool", toolCallId: "b", content: "denied", isError: true },
  ];
  const mapped = mapMessages(messages, false) as Array<{ role: string; content: any[] }>;
  assert.deepEqual(mapped.map((message) => message.role), ["user", "assistant", "user"]);
  assert.equal(mapped[1]!.content[0].type, "thinking");
  assert.deepEqual(mapped[2]!.content.map((block) => [block.tool_use_id, block.is_error ?? false]), [["a", false], ["b", true]]);
});

test("Gemini SSE stream returns function calls with thought signatures", async () => {
  process.env.TEST_API_KEY = "k";
  let url = "";
  streamingFetch(sse([
    { candidates: [{ content: { parts: [{ text: "Look" }] } }] },
    { candidates: [{ content: { parts: [{ functionCall: { name: "read_file", args: { path: "c.ts" } }, thoughtSignature: "sigG" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 5, thoughtsTokenCount: 7, cachedContentTokenCount: 20 } },
  ]), "text/event-stream", (_body, target) => { url = target; });
  const deltas: StreamDelta[] = [];
  const adapter = new GeminiAdapter("gemini", { kind: "gemini", apiKeyEnv: "TEST_API_KEY" });
  const response = await adapter.complete(request(deltas));
  assert.match(url, /streamGenerateContent\?alt=sse/);
  assert.equal(response.content, "Look");
  assert.equal(response.toolCalls[0]!.name, "read_file");
  assert.deepEqual(response.toolCalls[0]!.arguments, { path: "c.ts" });
  assert.equal(response.toolCalls[0]!.providerMeta?.thoughtSignature, "sigG");
  assert.equal(response.usage?.outputTokens, 12);
  assert.equal(response.usage?.cachedInputTokens, 20);
  const schema = sanitizeSchema({ type: "object", additionalProperties: false, properties: { x: { type: "string", format: "uri", $schema: "y" } } });
  assert.equal("additionalProperties" in (schema as object), false);
});

test("Ollama NDJSON stream sends num_ctx and assembles tool calls", async () => {
  let sent: any;
  streamingFetch([
    JSON.stringify({ message: { content: "Sure" }, done: false }) + "\n",
    JSON.stringify({ message: { content: "", tool_calls: [{ function: { name: "read_file", arguments: { path: "d.ts" } } }] }, done: false }) + "\n",
    JSON.stringify({ message: { content: "" }, done: true, prompt_eval_count: 30, eval_count: 4 }) + "\n",
  ], "application/x-ndjson", (body) => { sent = body; });
  const deltas: StreamDelta[] = [];
  const adapter = new OllamaAdapter("ollama", { kind: "ollama", baseUrl: "http://127.0.0.1:11434" });
  const response = await adapter.complete({ ...request(deltas), contextWindow: 32_768 });
  assert.equal(sent.options.num_ctx, 32_768);
  assert.equal(response.content, "Sure");
  assert.deepEqual(response.toolCalls.map((call) => [call.name, call.arguments]), [["read_file", { path: "d.ts" }]]);
  assert.deepEqual(response.usage, { inputTokens: 30, outputTokens: 4 });
});

test("provider HTTP errors are normalized into retryable and terminal kinds", async () => {
  process.env.TEST_API_KEY = "k";
  const adapter = new OpenAICompatibleAdapter("openai", { kind: "openai-compatible", baseUrl: "https://api.openai.com/v1", apiKeyEnv: "TEST_API_KEY" });
  const plain: CompletionRequest = { model: "m", messages: [{ role: "user", content: "x" }], tools: [] };
  const cases: Array<[number, string, Record<string, string>, string, boolean]> = [
    [429, '{"error":{"message":"slow down"}}', { "retry-after": "2" }, "rate_limit", true],
    [503, '{"error":{"message":"overloaded"}}', {}, "overloaded", true],
    [500, "oops", {}, "server", true],
    [401, '{"error":{"message":"invalid api key"}}', {}, "auth", false],
    [404, '{"error":{"message":"model not found"}}', {}, "not_found", false],
    [400, '{"error":{"message":"This model\'s maximum context length is 8192 tokens"}}', {}, "context_overflow", false],
  ];
  for (const [status, body, headers, kind, retryable] of cases) {
    errorFetch(status, body, headers);
    const error = await adapter.complete(plain).then(() => undefined, (caught: unknown) => caught);
    assert.ok(error instanceof ProviderError, `status ${status}`);
    assert.equal(error.kind, kind, `status ${status}`);
    assert.equal(error.retryable, retryable, `status ${status}`);
    if (status === 429) assert.equal(error.retryAfterMs, 2_000);
    assert.doesNotMatch(error.message, /Bearer k\b/);
  }
  globalThis.fetch = (async () => new Response("<html>gateway</html>", { status: 200, headers: { "content-type": "text/html" } })) as typeof fetch;
  const malformed = await adapter.complete(plain).then(() => undefined, (caught: unknown) => caught);
  assert.ok(malformed instanceof ProviderError && malformed.kind === "malformed");
  globalThis.fetch = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
  const network = await adapter.complete(plain).then(() => undefined, (caught: unknown) => caught);
  assert.ok(network instanceof ProviderError && network.kind === "network" && network.retryable);
  delete process.env.TEST_API_KEY;
  const missingKey = await adapter.complete(plain).then(() => undefined, (caught: unknown) => caught);
  assert.ok(missingKey instanceof ProviderError && missingKey.kind === "auth");
});

test("cancellation aborts an in-flight provider request", async () => {
  globalThis.fetch = ((_input: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  })) as typeof fetch;
  const adapter = new OpenAICompatibleAdapter("local", { kind: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1" });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);
  const error = await adapter.complete({ model: "m", messages: [{ role: "user", content: "x" }], tools: [], signal: controller.signal }).then(() => undefined, (caught: unknown) => caught);
  assert.ok(error instanceof ProviderError && error.kind === "cancelled");
});

test("retry backoff is exponential with jitter, honors Retry-After, and stops on terminal errors", async () => {
  const settings = { maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 1_000 };
  assert.equal(backoffDelay(1, settings, undefined, () => 1), 100);
  assert.equal(backoffDelay(3, settings, undefined, () => 1), 400);
  assert.equal(backoffDelay(3, settings, undefined, () => 0), 200);
  assert.equal(backoffDelay(10, settings, undefined, () => 1), 1_000);
  assert.equal(backoffDelay(1, settings, 5_000, () => 1), 5_000);
  let attempts = 0;
  await assert.rejects(withRetry(async () => { attempts += 1; throw new ProviderError("bad", 401); }, { ...settings, baseDelayMs: 1 }), /bad/);
  assert.equal(attempts, 1);
  attempts = 0;
  await assert.rejects(withRetry(async () => { attempts += 1; throw new ProviderError("busy", 503); }, { ...settings, baseDelayMs: 1, maxDelayMs: 2 }), /busy/);
  assert.equal(attempts, 4);
});
