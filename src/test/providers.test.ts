import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { AnthropicAdapter } from "../providers/anthropic.js";
import { GeminiAdapter } from "../providers/gemini.js";
import { OllamaAdapter } from "../providers/ollama.js";
import { OpenAICompatibleAdapter } from "../providers/openai-compatible.js";
import type { CompletionRequest } from "../types.js";

const originalFetch = globalThis.fetch;
const request: CompletionRequest = {
  model: "test-model",
  messages: [{ role: "system", content: "system" }, { role: "user", content: "hello" }],
  tools: [{
    name: "read_file",
    description: "Read",
    parameters: { type: "object", properties: { path: { type: "string" } } },
  }],
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.TEST_API_KEY;
});

function mockFetch(body: unknown, inspect?: (url: string, init?: RequestInit) => void): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    inspect?.(String(input), init);
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

test("OpenAI-compatible adapter normalizes tool calls", async () => {
  process.env.TEST_API_KEY = "secret";
  mockFetch({
    choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: "c1", function: { name: "read_file", arguments: '{"path":"README.md"}' } }] } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }, (url, init) => {
    assert.equal(url, "https://example.test/v1/chat/completions");
    assert.equal((init?.headers as Record<string, string>).authorization, "Bearer secret");
  });
  const adapter = new OpenAICompatibleAdapter("test", { kind: "openai-compatible", baseUrl: "https://example.test/v1", apiKeyEnv: "TEST_API_KEY" });
  const result = await adapter.complete(request);
  assert.deepEqual(result.toolCalls[0]?.arguments, { path: "README.md" });
  assert.equal(result.usage?.inputTokens, 10);
});

test("Anthropic adapter normalizes content blocks", async () => {
  process.env.TEST_API_KEY = "secret";
  mockFetch({ content: [{ type: "text", text: "checking" }, { type: "tool_use", id: "c2", name: "read_file", input: { path: "x" } }], stop_reason: "tool_use" });
  const adapter = new AnthropicAdapter("test", { kind: "anthropic", apiKeyEnv: "TEST_API_KEY" });
  const result = await adapter.complete(request);
  assert.equal(result.content, "checking");
  assert.equal(result.toolCalls[0]?.name, "read_file");
});

test("Gemini adapter normalizes function calls", async () => {
  process.env.TEST_API_KEY = "secret";
  mockFetch({ candidates: [{ finishReason: "STOP", content: { parts: [{ functionCall: { id: "c3", name: "read_file", args: { path: "x" } } }] } }] });
  const adapter = new GeminiAdapter("test", { kind: "gemini", apiKeyEnv: "TEST_API_KEY" });
  const result = await adapter.complete(request);
  assert.deepEqual(result.toolCalls[0]?.arguments, { path: "x" });
});

test("Ollama adapter uses the native chat endpoint", async () => {
  mockFetch({ message: { content: "done", tool_calls: [] }, done_reason: "stop", prompt_eval_count: 3, eval_count: 1 }, (url) => {
    assert.equal(url, "http://localhost:11434/api/chat");
  });
  const result = await new OllamaAdapter("ollama", { kind: "ollama" }).complete(request);
  assert.equal(result.content, "done");
  assert.equal(result.usage?.outputTokens, 1);
});
