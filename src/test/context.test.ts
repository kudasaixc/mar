import assert from "node:assert/strict";
import { test } from "node:test";
import { ContextManager, SUMMARY_HEADER } from "../context/manager.js";
import { TaskState } from "../context/task-state.js";
import { estimateMessages } from "../context/tokens.js";
import { ContextOverflowError } from "../errors.js";
import { resolveCapabilities } from "../providers/capabilities.js";
import type { ChatMessage, ContextSettings } from "../types.js";

const settings: ContextSettings = { compactAt: 0.8, targetAfterCompaction: 0.5, keepRecentTurns: 2, maxToolResultChars: 500, summarizer: "deterministic" };

function longSession(turns: number, outputSize = 3_000): { messages: ChatMessage[]; state: TaskState } {
  const state = new TaskState();
  const messages: ChatMessage[] = [{ role: "system", content: "You are a coding agent." }];
  const first = "Refactor the parser. NEVER modify files under vendor/. Keep the public API stable.";
  state.addInstruction(first);
  messages.push({ role: "user", content: first });
  state.updatePlan([{ step: "read parser", status: "done" }, { step: "split tokenizer", status: "in_progress" }], ["Keep parse() signature"]);
  for (let turn = 0; turn < turns; turn += 1) {
    const id = `call-${turn}`;
    messages.push({ role: "assistant", content: `Turn ${turn}: reading`, toolCalls: [{ id, name: "read_file", arguments: { path: `src/file${turn}.ts` } }] });
    messages.push({ role: "tool", toolCallId: id, toolName: "read_file", content: `src/file${turn}.ts\n${"x".repeat(outputSize)}` });
    state.recordToolResult("write_file", `w${turn}`, { ok: true, output: "ok", meta: { modifiedFiles: [`src/file${turn}.ts`] } });
    if (turn === 5) {
      const second = "Also add tests for the tokenizer.";
      state.addInstruction(second);
      messages.push({ role: "user", content: second });
    }
  }
  return { messages, state };
}

function assertPaired(messages: ChatMessage[]): void {
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      assert.equal(pending.size, 0, "tool results must directly follow their assistant message");
      for (const call of message.toolCalls ?? []) pending.add(call.id);
    } else if (message.role === "tool") {
      assert.ok(message.toolCallId && pending.delete(message.toolCallId), `orphan tool result ${message.toolCallId}`);
    } else assert.equal(pending.size, 0, "a non-tool message interrupted tool results");
  }
}

test("compaction keeps the system prompt, all instructions verbatim, and the task state", async () => {
  const capabilities = resolveCapabilities("plugin", "x", { contextWindow: 16_000, maxOutputTokens: 2_000 });
  const manager = new ContextManager(settings, capabilities, 2_000);
  const { messages, state } = longSession(40);
  assert.ok(manager.needsCompaction(messages, []));
  const report = await manager.compact(messages, [], state);
  assert.ok(report.compacted);
  assert.ok(report.afterTokens < report.beforeTokens);
  assert.ok(report.afterTokens <= manager.usable * settings.compactAt, `after=${report.afterTokens}`);
  assert.equal(messages[0]!.content, "You are a coding agent.");
  const summary = messages.find((message) => message.meta?.summary);
  assert.ok(summary);
  assert.ok(summary.content.startsWith(SUMMARY_HEADER));
  const everything = messages.map((message) => message.content).join("\n");
  assert.match(everything, /NEVER modify files under vendor\/\. Keep the public API stable\./);
  assert.match(everything, /Also add tests for the tokenizer\./);
  assert.match(summary.content, /split tokenizer/);
  assert.match(summary.content, /Keep parse\(\) signature/);
  assert.match(summary.content, /src\/file0\.ts/, "modified files survive in the task state");
  assertPaired(messages);
});

test("repeated compaction over a very long session stays bounded and valid", async () => {
  const capabilities = resolveCapabilities("plugin", "x", { contextWindow: 12_000, maxOutputTokens: 1_000 });
  const manager = new ContextManager(settings, capabilities, 1_000);
  const state = new TaskState();
  const messages: ChatMessage[] = [{ role: "system", content: "sys" }];
  state.addInstruction("Original goal: migrate the build to esbuild.");
  messages.push({ role: "user", content: "Original goal: migrate the build to esbuild." });
  for (let turn = 0; turn < 300; turn += 1) {
    messages.push({ role: "assistant", content: `step ${turn}`, toolCalls: [{ id: `c${turn}`, name: "run_command", arguments: { argv: ["npm", "test"] } }] });
    messages.push({ role: "tool", toolCallId: `c${turn}`, toolName: "run_command", content: "exit code 1\n" + "fail ".repeat(400), isError: true });
    if (manager.needsCompaction(messages, [])) await manager.compact(messages, [], state);
    assert.ok(estimateMessages(messages) < capabilities.contextWindow, `turn ${turn}: context exceeded the window`);
  }
  assert.match(messages.map((message) => message.content).join("\n"), /migrate the build to esbuild/);
  assertPaired(messages);
});

test("a model summarizer is used when available and failures fall back deterministically", async () => {
  const capabilities = resolveCapabilities("plugin", "x", { contextWindow: 16_000, maxOutputTokens: 2_000 });
  const ok = new ContextManager(settings, capabilities, 2_000);
  const a = longSession(30);
  await ok.compact(a.messages, [], a.state, { summarizer: async () => "MODEL SUMMARY: parser split halfway." });
  assert.match(a.messages.find((message) => message.meta?.summary)!.content, /MODEL SUMMARY/);

  const failing = new ContextManager(settings, capabilities, 2_000);
  const b = longSession(30);
  const report = await failing.compact(b.messages, [], b.state, { summarizer: async () => { throw new Error("provider down"); } });
  assert.ok(report.compacted);
  assert.ok(report.warnings.some((warning) => /provider down/.test(warning)));
  assert.match(b.messages.find((message) => message.meta?.summary)!.content, /read_file/);
});

test("compaction reports overflow instead of silently dropping pinned content", async () => {
  const capabilities = resolveCapabilities("plugin", "x", { contextWindow: 2_048, maxOutputTokens: 512 });
  const manager = new ContextManager(settings, capabilities, 512);
  const state = new TaskState();
  const huge = "Do this exact thing: " + "requirement ".repeat(3_000);
  state.addInstruction(huge);
  const messages: ChatMessage[] = [{ role: "system", content: "s".repeat(12_000) }, { role: "user", content: huge }];
  await assert.rejects(manager.compact(messages, [], state, { force: true }), ContextOverflowError);
});

test("task state verification reflects real check outcomes after the last change", () => {
  const state = new TaskState();
  assert.equal(state.verification().status, "no_changes");
  state.recordToolResult("write_file", "w", { ok: true, output: "", meta: { modifiedFiles: ["a.ts"] } });
  assert.equal(state.verification().status, "unverified");
  state.recordToolResult("run_command", "t", { ok: false, output: "", meta: { exitCode: 1, check: { name: "command", command: "npm test", passed: false, exitCode: 1 } } });
  assert.equal(state.verification().status, "checks_failed");
  state.recordToolResult("run_command", "t2", { ok: true, output: "", meta: { exitCode: 0, check: { name: "command", command: "npm test", passed: true, exitCode: 0 } } });
  assert.equal(state.verification().status, "tests_passing");
  state.recordToolResult("edit_file", "e", { ok: true, output: "", meta: { modifiedFiles: ["b.ts"] } });
  assert.equal(state.verification().status, "unverified", "a change after the last check invalidates it");
  const restored = TaskState.fromJSON(JSON.parse(JSON.stringify(state.toJSON())));
  assert.deepEqual([...restored.modifiedFiles].sort(), ["a.ts", "b.ts"]);
  assert.equal(restored.verification().status, "unverified");
});
