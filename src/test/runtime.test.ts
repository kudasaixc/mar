import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentRuntime } from "../runtime/agent.js";
import { ToolRegistry } from "../tools/registry.js";
import type { CompletionRequest, ModelAdapter } from "../types.js";
import type { ProviderRegistry } from "../providers/registry.js";

test("agent executes a tool loop and returns the final answer", async () => {
  let calls = 0;
  const adapter: ModelAdapter = {
    id: "fake",
    complete: async (request: CompletionRequest) => {
      calls += 1;
      if (calls === 1) return { content: "", toolCalls: [{ id: "1", name: "echo", arguments: { text: "hello" } }] };
      assert.equal(request.messages.at(-1)?.role, "tool");
      return { content: "finished", toolCalls: [] };
    },
  };
  const providers = { get: () => adapter } as unknown as ProviderRegistry;
  const tools = new ToolRegistry("never", async () => true).add({
    spec: { name: "echo", description: "echo", parameters: { type: "object" } },
    mutating: false,
    execute: async (args) => ({ ok: true, output: String(args.text) }),
  });
  const runtime = new AgentRuntime({
    profile: { name: "master", description: "test", provider: "fake", model: "fake" },
    providers,
    tools,
    workspace: "/tmp",
    teamContext: "test team",
    onEvent: () => undefined,
  });
  assert.equal(await runtime.run("do it"), "finished");
  assert.equal(calls, 2);
});

test("mutating tools honor read-only mode", async () => {
  const tools = new ToolRegistry("read-only", async () => true).add({
    spec: { name: "write", description: "write", parameters: { type: "object" } },
    mutating: true,
    execute: async () => ({ ok: true, output: "should not run" }),
  });
  const result = await tools.execute("write", {}, { agent: "test" });
  assert.equal(result.ok, false);
  assert.match(result.output, /read-only/);
});
