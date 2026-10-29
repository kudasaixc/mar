#!/usr/bin/env node
// Deterministic harness benchmarks. Every scenario drives the real MAR runtime
// (dist/) with a scripted provider, so results measure MAR's own behavior
// (correctness, overhead, recovery) and never model quality. No network access.
//
//   npm run build && node scripts/bench.mjs [--json results.json]
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const dist = new URL("../dist/", import.meta.url);
const { Orchestrator } = await import(new URL("runtime/orchestrator.js", dist));
const { SessionStore } = await import(new URL("session/store.js", dist));
const { ProviderError } = await import(new URL("errors.js", dist));

const temporary = [];
async function temp(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(dir);
  return dir;
}

const state = await temp("mar-bench-state-");
process.env.MAR_STATE_DIR = join(state, "sessions");
const pluginPath = join(state, "provider.mjs");
await writeFile(pluginPath, "export default { apiVersion: 1, createProvider: () => ({ id: 'bench', complete: (r) => globalThis.__bench(r) }) };\n");

let requests = 0;
let toolCalls = 0;
function script(fn) {
  globalThis.__bench = async (request) => {
    requests += 1;
    const response = await fn(request);
    toolCalls += response.toolCalls?.length ?? 0;
    return response;
  };
}

const results = (request) => request.messages.filter((message) => message.role === "tool");
const userText = (request) => request.messages.filter((message) => message.role === "user").map((message) => message.content).join("\n");

function config(workers = [], runtime = {}, extra = {}) {
  return {
    version: 2,
    providers: { bench: { kind: "plugin", module: pluginPath }, backup: { kind: "plugin", module: pluginPath } },
    team: {
      master: { name: "master", description: "bench", provider: "bench", model: "master", ...extra },
      workers: workers.map((name) => ({ name, description: name, provider: "bench", model: `worker-${name}` })),
    },
    runtime: { approval: "never", commandTimeoutMs: 20_000, maxToolOutput: 20_000, plugins: [], stream: false, retry: { maxAttempts: 4, baseDelayMs: 5, maxDelayMs: 20 }, ...runtime },
  };
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "b", GIT_AUTHOR_EMAIL: "b@b", GIT_COMMITTER_NAME: "b", GIT_COMMITTER_EMAIL: "b@b" } });
}

/** A scripted agent that performs `steps` (tool calls) in order, then answers. */
function steps(list, answer = "done") {
  return (request) => {
    const index = results(request).length;
    const step = list[index];
    if (!step) return { content: answer, toolCalls: [] };
    return { content: "", toolCalls: [{ id: `s${index}`, name: step[0], arguments: typeof step[1] === "function" ? step[1](request) : step[1] }] };
  };
}

const scenarios = [
  {
    name: "single-file edit + test",
    async run() {
      const ws = await temp("mar-b1-");
      await writeFile(join(ws, "sum.mjs"), "export const sum = (a, b) => a - b;\n");
      await writeFile(join(ws, "check.mjs"), "import { sum } from './sum.mjs'; if (sum(2, 3) !== 5) { console.error('wrong'); process.exit(1); }\n");
      script(steps([
        ["read_file", { path: "sum.mjs" }],
        ["edit_file", { path: "sum.mjs", old_text: "a - b", new_text: "a + b" }],
        ["run_command", { argv: ["node", "check.mjs"] }],
      ]));
      const runtime = await Orchestrator.create({ config: config([], { checks: { test: "node check.mjs" } }), workspace: ws, approve: async () => true });
      const report = await runtime.runTask("fix sum", { verify: true });
      return { ok: report.overall === "confirmed", detail: `status=${report.status} overall=${report.overall}` };
    },
  },
  {
    name: "multi-file atomic patch",
    async run() {
      const ws = await temp("mar-b2-");
      for (let index = 0; index < 5; index += 1) await writeFile(join(ws, `f${index}.txt`), `line ${index}\n`);
      const patch = Array.from({ length: 5 }, (_, index) => `--- a/f${index}.txt\n+++ b/f${index}.txt\n@@ -1 +1 @@\n-line ${index}\n+LINE ${index}\n`).join("");
      script(steps([...Array.from({ length: 5 }, (_, index) => ["read_file", { path: `f${index}.txt` }]), ["apply_patch", { patch }]]));
      const runtime = await Orchestrator.create({ config: config(), workspace: ws, approve: async () => true });
      const report = await runtime.runTask("uppercase");
      const contents = await Promise.all(Array.from({ length: 5 }, (_, index) => readFile(join(ws, `f${index}.txt`), "utf8")));
      return { ok: contents.every((text, index) => text === `LINE ${index}\n`) && report.modifiedFiles.length === 5, detail: `${report.modifiedFiles.length} files` };
    },
  },
  {
    name: "failing check is reported, then fixed",
    async run() {
      const ws = await temp("mar-b3-");
      await writeFile(join(ws, "flag.txt"), "broken\n");
      const check = ["run_check", { name: "test" }];
      const outcomes = [];
      script((request) => {
        const last = results(request).at(-1);
        if (last && /^exit code/.test(last.content)) outcomes.push(/^exit code 0 /.test(last.content) ? "pass" : "fail");
        return steps([["read_file", { path: "flag.txt" }], ["write_file", { path: "flag.txt", content: "still broken\n" }], check, ["write_file", { path: "flag.txt", content: "fixed\n" }], check])(request);
      });
      const command = "node -e \"process.exit(require('fs').readFileSync('flag.txt','utf8').trim()==='fixed'?0:1)\"";
      const runtime = await Orchestrator.create({ config: config([], { checks: { test: command } }), workspace: ws, approve: async () => true });
      const report = await runtime.runTask("fix flag");
      return { ok: report.verification.status === "tests_passing" && outcomes.join(",") === "fail,pass", detail: `check results=${outcomes.join(",")} verification=${report.verification.status}` };
    },
  },
  {
    name: "long session compaction (250 turns, 16k window)",
    async run() {
      const ws = await temp("mar-b4-");
      await writeFile(join(ws, "big.txt"), "x".repeat(6_000));
      let maxPrompt = 0;
      let instructionKept = true;
      let turn = 0;
      script((request) => {
        const size = JSON.stringify(request.messages).length;
        maxPrompt = Math.max(maxPrompt, size);
        if (request.tools.length === 0) return { content: "summary of reading big.txt repeatedly", toolCalls: [] };
        if (!JSON.stringify(request.messages).includes("CODEWORD-ORCA")) instructionKept = false;
        turn += 1;
        return turn <= 250 ? { content: "", toolCalls: [{ id: `t${turn}`, name: "read_file", arguments: { path: "big.txt", start_line: 1, end_line: turn % 2 ? 1 : 2 } }] } : { content: "done", toolCalls: [] };
      });
      const events = [];
      const runtime = await Orchestrator.create({
        config: config([], {}, { maxTurns: 300, capabilities: { contextWindow: 16_000, maxOutputTokens: 2_000 } }),
        workspace: ws, approve: async () => true, onEvent: (event) => { if (event.type === "agent:compaction") events.push(event); },
      });
      const report = await runtime.runTask("Read big.txt many times. Remember CODEWORD-ORCA.");
      return { ok: report.status === "completed" && instructionKept && events.length > 0, detail: `${events.length} compactions, max prompt ${Math.round(maxPrompt / 1000)}k chars, instruction kept=${instructionKept}` };
    },
  },
  {
    name: "transient provider errors are retried",
    async run() {
      const ws = await temp("mar-b5-");
      let count = 0;
      let writes = 0;
      script((request) => {
        count += 1;
        if (count === 2 || count === 3) throw new ProviderError("503 overloaded", 503);
        if (!results(request).length) return { content: "", toolCalls: [{ id: "w", name: "write_file", arguments: { path: "once.txt", content: "1\n" } }] };
        writes = results(request).length;
        return { content: "ok", toolCalls: [] };
      });
      const runtime = await Orchestrator.create({ config: config(), workspace: ws, approve: async () => true });
      const report = await runtime.runTask("write once");
      return { ok: report.status === "completed" && writes === 1, detail: `provider calls=${count}, tool executions=${writes}` };
    },
  },
  {
    name: "fallback model after auth failure",
    async run() {
      const ws = await temp("mar-b6-");
      script((request) => {
        if (request.model === "primary") throw new ProviderError("invalid api key", 401);
        return { content: "answered by backup", toolCalls: [] };
      });
      const runtime = await Orchestrator.create({ config: config([], {}, { model: "primary", fallbacks: [{ provider: "backup", model: "secondary" }] }), workspace: ws, approve: async () => true });
      const report = await runtime.runTask("hello");
      return { ok: report.output === "answered by backup", detail: report.output };
    },
  },
  {
    name: "parallel delegation (4 workers × 300ms)",
    async run() {
      const ws = await temp("mar-b7-");
      script(async (request) => {
        if (request.model.startsWith("worker")) {
          await new Promise((resolve) => setTimeout(resolve, 300));
          return { content: `${request.model} finished`, toolCalls: [] };
        }
        if (!results(request).length) return { content: "", toolCalls: ["a", "b", "c", "d"].map((agent, index) => ({ id: `d${index}`, name: "delegate", arguments: { agent, task: `part ${agent}` } })) };
        return { content: "integrated", toolCalls: [] };
      });
      const runtime = await Orchestrator.create({ config: config(["a", "b", "c", "d"], { concurrency: { maxWorkers: 4, isolation: "shared" } }), workspace: ws, approve: async () => true });
      const started = performance.now();
      const report = await runtime.runTask("split");
      const elapsed = performance.now() - started;
      return { ok: report.status === "completed" && elapsed < 900, detail: `${Math.round(elapsed)}ms (sequential would be ≥1200ms)` };
    },
  },
  {
    name: "worktree isolation with one conflict",
    async run() {
      const ws = await temp("mar-b8-");
      git(ws, "init", "-q", "-b", "main");
      await writeFile(join(ws, "a.txt"), "a\n");
      await writeFile(join(ws, "b.txt"), "b\n");
      git(ws, "add", "-A");
      git(ws, "commit", "-q", "-m", "init");
      script((request) => {
        if (request.model.startsWith("worker")) {
          const task = userText(request);
          const file = task.includes("a.txt") ? "a.txt" : "b.txt";
          const done = results(request).length;
          if (done === 0) return { content: "", toolCalls: [{ id: "r", name: "read_file", arguments: { path: file } }] };
          if (done === 1) {
            return (async () => {
              if (file === "b.txt") await writeFile(join(ws, "b.txt"), "user changed b\n");
              return { content: "", toolCalls: [{ id: "w", name: "write_file", arguments: { path: file, content: `${file} by worker\n` } }] };
            })();
          }
          return { content: "edited", toolCalls: [] };
        }
        if (!results(request).length) return { content: "", toolCalls: [{ id: "x", name: "delegate", arguments: { agent: "one", task: "edit a.txt" } }, { id: "y", name: "delegate", arguments: { agent: "two", task: "edit b.txt" } }] };
        return { content: "done", toolCalls: [] };
      });
      const runtime = await Orchestrator.create({ config: config(["one", "two"], { concurrency: { isolation: "worktree" } }), workspace: ws, approve: async () => true });
      const report = await runtime.runTask("edit both");
      const a = await readFile(join(ws, "a.txt"), "utf8");
      const b = await readFile(join(ws, "b.txt"), "utf8");
      const statuses = report.tasks.map((task) => task.status).sort().join(",");
      await runtime.close();
      return { ok: a === "a.txt by worker\n" && b === "user changed b\n" && statuses === "conflict,integrated" && report.overall === "incomplete", detail: `tasks=${statuses} overall=${report.overall}` };
    },
  },
  {
    name: "crash recovery without replay",
    async run() {
      const ws = await temp("mar-b9-");
      const session = await SessionStore.create(ws);
      await session.append("message", { role: "user", content: "deploy" }, "master");
      await session.append("message", { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "run_command", arguments: { argv: ["touch", "deployed.txt"] } }] }, "master");
      await session.append("tool:start", { callId: "c1", name: "run_command" }, "master");
      await session.close("interrupted");
      const reopened = await SessionStore.open(session.metadata.id);
      const recovered = await reopened.recover("master");
      let sawInterrupted = false;
      script((request) => {
        sawInterrupted ||= results(request).some((message) => /INTERRUPTED/.test(message.content));
        return { content: "will verify state first", toolCalls: [] };
      });
      const runtime = await Orchestrator.create({ config: config(), workspace: ws, approve: async () => true, session: reopened, recovered });
      await runtime.runTask("continue");
      await runtime.close("completed");
      const replayed = await readFile(join(ws, "deployed.txt")).then(() => true, () => false);
      return { ok: sawInterrupted && !replayed, detail: `interrupted call surfaced=${sawInterrupted}, replayed=${replayed}` };
    },
  },
  {
    name: "cancellation latency during a long command",
    async run() {
      const ws = await temp("mar-b10-");
      script(steps([["run_command", { argv: ["sleep", "30"] }]]));
      const runtime = await Orchestrator.create({ config: config(), workspace: ws, approve: async () => true });
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 300);
      const started = performance.now();
      const report = await runtime.runTask("wait", { signal: controller.signal });
      const latency = performance.now() - started - 300;
      return { ok: report.status === "cancelled" && latency < 1_500, detail: `stopped ${Math.round(latency)}ms after Ctrl+C` };
    },
  },
];

const rows = [];
for (const scenario of scenarios) {
  requests = 0;
  toolCalls = 0;
  const started = performance.now();
  let outcome;
  try {
    outcome = await scenario.run();
  } catch (error) {
    outcome = { ok: false, detail: `threw: ${error instanceof Error ? error.message : String(error)}` };
  }
  rows.push({ scenario: scenario.name, passed: outcome.ok, ms: Math.round(performance.now() - started), requests, toolCalls, detail: outcome.detail });
}
await Promise.all(temporary.map((dir) => rm(dir, { recursive: true, force: true })));

const width = Math.max(...rows.map((row) => row.scenario.length));
console.log(`MAR deterministic benchmarks (Node ${process.version}, ${process.platform})\n`);
for (const row of rows) {
  console.log(`${row.passed ? "PASS" : "FAIL"}  ${row.scenario.padEnd(width)}  ${String(row.ms).padStart(6)}ms  ${String(row.requests).padStart(4)} req  ${String(row.toolCalls).padStart(4)} tools  ${row.detail}`);
}
const passed = rows.filter((row) => row.passed).length;
console.log(`\n${passed}/${rows.length} scenarios passed`);
const jsonIndex = process.argv.indexOf("--json");
if (jsonIndex > 0 && process.argv[jsonIndex + 1]) {
  await writeFile(process.argv[jsonIndex + 1], `${JSON.stringify({ node: process.version, platform: process.platform, at: new Date().toISOString(), rows }, null, 2)}\n`);
}
process.exit(passed === rows.length ? 0 : 1);
