import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { TaskManager, type TaskRecord } from "../orchestration/tasks.js";
import { Orchestrator } from "../runtime/orchestrator.js";
import type { CompletionRequest, RuntimeEvent } from "../types.js";
import { cleanup, config, fakeProviderModule, git, gitRepo, setScript, tempDir, toolResults } from "./helpers.js";

let module: string;
before(async () => {
  const state = await tempDir("mar-conc-state-");
  process.env.MAR_STATE_DIR = join(state, "sessions");
  module = await fakeProviderModule(state);
});
after(cleanup);

function manager(execute: (record: TaskRecord, signal: AbortSignal) => Promise<void>, overrides: Partial<ConstructorParameters<typeof TaskManager>[0]> = {}) {
  return new TaskManager({ maxWorkers: 2, timeoutMs: 5_000, maxDelegations: 10, onEvent: () => undefined, execute, ...overrides });
}

test("task manager enforces the concurrency limit and dependency order", async () => {
  let active = 0;
  let peak = 0;
  const order: string[] = [];
  const tasks = manager(async (record) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 50));
    order.push(record.label ?? record.id);
    record.agentStatus = "completed";
    active -= 1;
  });
  const results = await Promise.all([
    tasks.submit({ agent: "w", task: "c", label: "c", dependsOn: ["a", "b"], isolation: "shared" }),
    tasks.submit({ agent: "w", task: "a", label: "a", isolation: "shared" }),
    tasks.submit({ agent: "w", task: "b", label: "b", isolation: "shared" }),
    tasks.submit({ agent: "w", task: "d", label: "d", isolation: "shared" }),
  ]);
  assert.ok(results.every((record) => record.status === "completed"));
  assert.equal(peak, 2);
  assert.ok(order.indexOf("c") > order.indexOf("a") && order.indexOf("c") > order.indexOf("b"));
});

test("failed dependencies, cycles, unknown labels, timeouts and limits are reported, not hung", async () => {
  const tasks = manager(async (record, signal) => {
    if (record.task === "fail") { record.agentStatus = "failed"; record.error = "broken"; return; }
    if (record.task === "slow") await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    record.agentStatus = "completed";
  }, { timeoutMs: 200, maxDelegations: 6 });
  const [failed, dependent] = await Promise.all([
    tasks.submit({ agent: "w", task: "fail", label: "base", isolation: "shared" }),
    tasks.submit({ agent: "w", task: "ok", dependsOn: ["base"], isolation: "shared" }),
  ]);
  assert.equal(failed.status, "failed");
  assert.equal(dependent.status, "blocked");
  assert.match(dependent.error ?? "", /ended as failed/);

  const [x, y] = await Promise.all([
    tasks.submit({ agent: "w", task: "ok", label: "x", dependsOn: ["y"], isolation: "shared" }),
    tasks.submit({ agent: "w", task: "ok", label: "y", dependsOn: ["x"], isolation: "shared" }),
  ]);
  assert.ok([x, y].some((record) => record.status === "blocked" && /cycle/i.test(record.error ?? "")));

  const slow = await tasks.submit({ agent: "w", task: "slow", isolation: "shared" });
  assert.equal(slow.status, "timed_out");
  const unknown = await tasks.submit({ agent: "w", task: "ok", dependsOn: ["t999"], isolation: "shared" });
  assert.equal(unknown.status, "blocked");
  await assert.rejects(tasks.submit({ agent: "w", task: "ok", isolation: "shared" }), /Delegation limit/);
});

test("cancelAll stops running and queued tasks", async () => {
  const tasks = manager(async (_record, signal) => {
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
  }, { maxWorkers: 1 });
  const pending = [1, 2, 3].map(() => tasks.submit({ agent: "w", task: "wait", isolation: "shared" }));
  setTimeout(() => tasks.cancelAll(), 50);
  const results = await Promise.all(pending);
  assert.ok(results.every((record) => record.status === "cancelled"), results.map((record) => record.status).join(","));
});

/** Master: first response delegates `delegations`; afterwards it answers with the tool results it saw. */
function masterScript(delegations: Array<Record<string, unknown>>, worker: (request: CompletionRequest) => ReturnType<Parameters<typeof setScript>[0]>) {
  setScript((request) => {
    if (request.model.startsWith("worker")) return worker(request);
    const results = toolResults(request);
    if (!results.length) return { content: "", toolCalls: delegations.map((args, index) => ({ id: `d${index}`, name: "delegate", arguments: args })) };
    return { content: results.map((message) => message.content).join("\n=====\n"), toolCalls: [] };
  });
}

/** Worker: on its first turn edits a file, then reports. */
function editingWorker(edits: Record<string, (current: string) => string>, beforeWrite: (path: string) => Promise<void> = async () => undefined) {
  return async (request: CompletionRequest) => {
    const task = request.messages.find((message) => message.role === "user")!.content;
    const path = Object.keys(edits).find((candidate) => task.includes(candidate))!;
    const results = toolResults(request);
    if (results.length === 0) return { content: "", toolCalls: [{ id: "r", name: "read_file", arguments: { path } }] };
    if (results.length === 1) {
      await beforeWrite(path);
      const current = results[0]!.content.split("\n").slice(1).map((line) => line.replace(/^\d+: /, "")).join("\n") + "\n";
      return { content: "", toolCalls: [{ id: "w", name: "write_file", arguments: { path, content: edits[path]!(current) } }] };
    }
    return { content: `${path} updated (${results[1]!.isError ? "FAILED" : "ok"})`, toolCalls: [] };
  };
}

test("shared mode: concurrent workers writing the same file cannot silently overwrite each other", async () => {
  const workspace = await tempDir("mar-shared-");
  await writeFile(join(workspace, "same.txt"), "base\n");
  masterScript(
    [{ agent: "one", task: "edit same.txt (one)" }, { agent: "two", task: "edit same.txt (two)" }],
    (request) => {
      const name = request.model;
      const results = toolResults(request);
      if (results.length === 0) return { content: "", toolCalls: [{ id: "r", name: "read_file", arguments: { path: "same.txt" } }] };
      if (results.length === 1) return new Promise((resolve) => setTimeout(() => resolve({ content: "", toolCalls: [{ id: "w", name: "edit_file", arguments: { path: "same.txt", old_text: "base", new_text: name } }] }), 30));
      return { content: `${name}: ${results[1]!.isError ? "REFUSED " + results[1]!.content : "ok"}`, toolCalls: [] };
    },
  );
  const runtime = await Orchestrator.create({ config: config(module, ["one", "two"], { concurrency: { isolation: "shared" } }), workspace, approve: async () => true });
  const output = await runtime.run("go");
  const final = await readFile(join(workspace, "same.txt"), "utf8");
  assert.ok(final === "worker-one\n" || final === "worker-two\n", final);
  assert.match(output, /REFUSED .*modified by agent/);
  assert.equal((output.match(/: ok/g) ?? []).length, 1, "exactly one write won");
});

test("worktree mode: parallel workers are isolated and integrated with conflict detection", async () => {
  const root = await gitRepo({ "a.txt": "alpha\n", "b.txt": "beta\n", "c.txt": "gamma\n" });
  // Uncommitted user work must be visible to workers and must survive integration.
  await writeFile(join(root, "notes.txt"), "user's uncommitted notes\n");
  await writeFile(join(root, "c.txt"), "gamma (user edit)\n");
  masterScript(
    [
      { agent: "one", task: "update a.txt" },
      { agent: "two", task: "update b.txt" },
      { agent: "three", task: "update c.txt" },
    ],
    editingWorker({
      "a.txt": (current) => current.replace("alpha", "ALPHA"),
      "b.txt": (current) => current.replace("beta", "BETA"),
      "c.txt": (current) => current.replace("gamma", "GAMMA"),
    }, async (path) => {
      // While worker three is mid-task (after its snapshot), the user edits c.txt again.
      if (path === "c.txt") await writeFile(join(root, "c.txt"), "something else entirely\n");
    }),
  );
  const events: RuntimeEvent[] = [];
  const runtime = await Orchestrator.create({
    config: config(module, ["one", "two", "three"], { concurrency: { isolation: "worktree", maxWorkers: 3 } }),
    workspace: root, approve: async () => true, onEvent: (event) => events.push(event),
  });
  const report = await runtime.runTask("go");
  assert.equal(report.status, "completed");
  assert.equal(await readFile(join(root, "a.txt"), "utf8"), "ALPHA\n");
  assert.equal(await readFile(join(root, "b.txt"), "utf8"), "BETA\n");
  assert.equal(await readFile(join(root, "c.txt"), "utf8"), "something else entirely\n", "conflicting change was not applied");
  assert.equal(await readFile(join(root, "notes.txt"), "utf8"), "user's uncommitted notes\n");
  const byFile = new Map(report.tasks.map((task) => [task.task.split(" ").pop(), task]));
  assert.equal(byFile.get("a.txt")!.status, "integrated");
  assert.equal(byFile.get("b.txt")!.status, "integrated");
  assert.equal(byFile.get("c.txt")!.status, "conflict");
  assert.ok(byFile.get("c.txt")!.worktree, "the conflicting worktree is kept for inspection");
  assert.equal(report.overall, "incomplete", "an unresolved conflict means the run is not complete");
  // Integration never touches the user's index, branch or history.
  assert.equal(git(root, "log", "--oneline").trim().split("\n").length, 1);
  assert.equal(git(root, "diff", "--cached", "--name-only").trim(), "");
  assert.equal(git(root, "branch", "--show-current").trim(), "main");
  assert.ok(events.some((event) => event.type === "task:update" && event.status === "conflict"));
  const worktrees = git(root, "worktree", "list").trim().split("\n");
  assert.equal(worktrees.length, 2, "integrated worktrees are removed; the conflicting one remains");
  await runtime.close();
});

test("workers cannot delegate further", async () => {
  const workspace = await tempDir("mar-nodelegate-");
  let workerTools: string[] = [];
  masterScript([{ agent: "one", task: "anything" }], (request) => {
    workerTools = request.tools.map((tool) => tool.name);
    return { content: "done", toolCalls: [] };
  });
  const runtime = await Orchestrator.create({ config: config(module, ["one"]), workspace, approve: async () => true });
  await runtime.run("go");
  assert.ok(workerTools.length > 0);
  assert.equal(workerTools.includes("delegate"), false);
});
