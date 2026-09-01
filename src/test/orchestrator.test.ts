import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { Orchestrator } from "../runtime/orchestrator.js";
import type { MarConfig } from "../types.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("orchestrator completes an HTTP model-to-workspace tool loop", async () => {
  const root = await mkdtemp(join(tmpdir(), "mar-e2e-"));
  temporary.push(root);
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(requests === 1 ? {
      choices: [{ finish_reason: "tool_calls", message: {
        content: "",
        tool_calls: [{ id: "write-1", function: { name: "write_file", arguments: '{"path":"result.txt","content":"built by MAR\\n"}' } }],
      } }],
    } : {
      choices: [{ finish_reason: "stop", message: { content: "Verified and complete." } }],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert(address && typeof address === "object");
    const config: MarConfig = {
      version: 1,
      providers: { mock: { kind: "openai-compatible", baseUrl: `http://127.0.0.1:${address.port}/v1` } },
      team: { master: { name: "master", description: "test", provider: "mock", model: "test" }, workers: [] },
      runtime: { approval: "never", commandTimeoutMs: 5_000, maxToolOutput: 10_000, plugins: [] },
    };
    const runtime = await Orchestrator.create({ config, workspace: root, approve: async () => true });
    assert.equal(await runtime.run("build it"), "Verified and complete.");
    assert.equal(await readFile(join(root, "result.txt"), "utf8"), "built by MAR\n");
    assert.equal(requests, 2);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("master delegate calls execute workers concurrently", async () => {
  const root = await mkdtemp(join(tmpdir(), "mar-parallel-"));
  temporary.push(root);
  const pluginPath = join(root, "provider.mjs");
  await writeFile(pluginPath, `
export default {
  apiVersion: 1,
  createProvider: () => ({
    id: "fake",
    async complete(request) {
      if (request.model.startsWith("worker")) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return { content: request.model + " done", toolCalls: [] };
      }
      const hasResults = request.messages.some((message) => message.role === "tool");
      if (hasResults) return { content: "integrated", toolCalls: [] };
      return { content: "", toolCalls: [
        { id: "d1", name: "delegate", arguments: { agent: "one", task: "first" } },
        { id: "d2", name: "delegate", arguments: { agent: "two", task: "second" } }
      ] };
    }
  })
};
`, "utf8");
  const config: MarConfig = {
    version: 1,
    providers: { fake: { kind: "plugin", module: pluginPath } },
    team: {
      master: { name: "master", description: "coordinate", provider: "fake", model: "master" },
      workers: [
        { name: "one", description: "first", provider: "fake", model: "worker-one" },
        { name: "two", description: "second", provider: "fake", model: "worker-two" },
      ],
    },
    runtime: { approval: "never", commandTimeoutMs: 5_000, maxToolOutput: 10_000, plugins: [] },
  };
  const runtime = await Orchestrator.create({ config, workspace: root, approve: async () => true });
  const started = Date.now();
  assert.equal(await runtime.run("coordinate"), "integrated");
  assert(Date.now() - started < 280, "workers should run in parallel, not sequentially");
});
