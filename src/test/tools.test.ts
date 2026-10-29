import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { TaskState } from "../context/task-state.js";
import { MemoryStore } from "../memory/store.js";
import { addBuiltinTools } from "../tools/builtins.js";
import { detectChecks } from "../tools/checks.js";
import { ProcessManager } from "../tools/processes.js";
import { parsePatch } from "../tools/patch.js";
import { ToolRegistry } from "../tools/registry.js";
import { Workspace } from "../tools/workspace.js";
import { cleanup, gitRepo, nodeArgv, tempDir } from "./helpers.js";

after(cleanup);

async function setup(files: Record<string, string> = {}, root?: string) {
  const dir = root ?? await tempDir("mar-tools-");
  for (const [path, content] of Object.entries(files)) await writeFile(join(dir, path), content);
  const workspace = await Workspace.create(dir);
  const taskState = new TaskState();
  const processes = new ProcessManager();
  const registry = addBuiltinTools(new ToolRegistry("never", async () => true), {
    workspace, memory: new MemoryStore("s", undefined), taskState, processes, checks: { test: "node -e \"process.exit(0)\"" },
  });
  const call = (name: string, args: Record<string, unknown>, agent = "a") => registry.execute(name, args, { agent });
  return { dir, workspace, taskState, processes, registry, call };
}

test("apply_patch applies multi-file diffs atomically and rolls back on any failure", async () => {
  const { dir, call } = await setup({ "a.txt": "one\ntwo\nthree\n", "b.txt": "uno\ndos\n" });
  await call("read_file", { path: "a.txt" });
  await call("read_file", { path: "b.txt" });
  const good = `--- a/a.txt
+++ b/a.txt
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
--- a/b.txt
+++ b/b.txt
@@ -1,2 +1,3 @@
 uno
 dos
+tres
--- /dev/null
+++ b/new.txt
@@ -0,0 +1 @@
+created
`;
  const result = await call("apply_patch", { patch: good });
  assert.equal(result.ok, true, result.output);
  assert.deepEqual([...(result.meta?.modifiedFiles ?? [])].sort(), ["a.txt", "b.txt", "new.txt"]);
  assert.equal(await readFile(join(dir, "a.txt"), "utf8"), "one\nTWO\nthree\n");
  assert.equal(await readFile(join(dir, "new.txt"), "utf8"), "created\n");

  const bad = `--- a/a.txt
+++ b/a.txt
@@ -1,1 +1,1 @@
-one
+ONE
--- a/b.txt
+++ b/b.txt
@@ -1,1 +1,1 @@
-this line does not exist
+x
`;
  const failed = await call("apply_patch", { patch: bad });
  assert.equal(failed.ok, false);
  assert.equal(await readFile(join(dir, "a.txt"), "utf8"), "one\nTWO\nthree\n", "first file untouched when the second hunk fails");
  assert.equal(parsePatch(good).length, 3);
});

test("apply_patch tolerates shifted hunks but refuses ambiguous ones", async () => {
  const { dir, call } = await setup({ "f.txt": "header\nextra\nalpha\nbeta\ngamma\n", "dup.txt": "x\ny\nx\ny\n" });
  await call("read_file", { path: "f.txt" });
  const shifted = await call("apply_patch", { patch: "--- a/f.txt\n+++ b/f.txt\n@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n gamma\n" });
  assert.equal(shifted.ok, true, shifted.output);
  assert.equal(await readFile(join(dir, "f.txt"), "utf8"), "header\nextra\nalpha\nBETA\ngamma\n");
  await call("read_file", { path: "dup.txt" });
  const ambiguous = await call("apply_patch", { patch: "--- a/dup.txt\n+++ b/dup.txt\n@@ -50,2 +50,2 @@\n x\n-y\n+Y\n" });
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.output, /ambiguous|matches|context/i);
});

test("edit_file applies ordered edits atomically", async () => {
  const { dir, call } = await setup({ "c.ts": "const a = 1;\nconst b = 2;\n" });
  await call("read_file", { path: "c.ts" });
  const result = await call("edit_file", { path: "c.ts", edits: [{ old_text: "a = 1", new_text: "a = 10" }, { old_text: "missing", new_text: "x" }] });
  assert.equal(result.ok, false);
  assert.equal(await readFile(join(dir, "c.ts"), "utf8"), "const a = 1;\nconst b = 2;\n");
  const ok = await call("edit_file", { path: "c.ts", edits: [{ old_text: "a = 1", new_text: "a = 10" }, { old_text: "b = 2", new_text: "b = 20" }] });
  assert.equal(ok.ok, true, ok.output);
  assert.equal(await readFile(join(dir, "c.ts"), "utf8"), "const a = 10;\nconst b = 20;\n");
});

test("run_command distinguishes failure, empty output, timeouts, and checks", async () => {
  const { call, taskState } = await setup();
  const empty = await call("run_command", { argv: nodeArgv("") });
  assert.equal(empty.ok, true);
  assert.match(empty.output, /exit code 0/);
  assert.match(empty.output, /no output/);
  const failing = await call("run_command", { argv: nodeArgv("console.error('oops'); process.exit(3)") });
  assert.equal(failing.ok, false);
  assert.equal(failing.meta?.exitCode, 3);
  assert.match(failing.output, /exit code 3/);
  assert.match(failing.output, /oops/);
  const missing = await call("run_command", { argv: ["definitely-not-a-command-xyz"] });
  assert.equal(missing.ok, false);
  assert.match(missing.output, /ENOENT|not found/i);
  const slow = await call("run_command", { argv: nodeArgv("setTimeout(() => {}, 5000)"), timeout_ms: 200 });
  assert.equal(slow.ok, false);
  assert.equal(slow.meta?.timedOut, true);
  assert.match(slow.output, /TIMED OUT/);
  const both = await call("run_command", { argv: ["ls"], command: "ls" });
  assert.equal(both.ok, false);
  const check = await call("run_check", { name: "test" });
  assert.equal(check.ok, true);
  assert.equal(check.meta?.check?.passed, true);
  void taskState;
});

test("background processes can be started, read, listed, and stopped with their children", async () => {
  const { call, processes } = await setup();
  const started = await call("process_start", { argv: nodeArgv("console.log('ready'); setTimeout(() => {}, 30000)") });
  assert.equal(started.ok, true, started.output);
  const id = started.output.match(/p\d+/)![0];
  await new Promise((resolve) => setTimeout(resolve, 200));
  const output = await call("process_output", { id });
  assert.match(output.output, /ready/);
  assert.match(output.output, /running/i);
  const stopped = await call("process_stop", { id });
  assert.equal(stopped.ok, true);
  const after = await call("process_output", { id });
  assert.doesNotMatch(after.output, /running/i);
  await processes.stopAll();
});

test("search, find_files and git tools report results, empty results, and errors distinctly", async () => {
  const root = await gitRepo({ "main.ts": "export function hello() {}\n", "util.ts": "// helper\n" });
  const { call } = await setup({}, root);
  await writeFile(join(root, "new.ts"), "untracked\n");
  const found = await call("search", { pattern: "hello" });
  assert.match(found.output, /main\.ts:1:/);
  const none = await call("search", { pattern: "zzz_nothing_here" });
  assert.equal(none.ok, true);
  assert.match(none.output, /no matches/i);
  const invalid = await call("search", { pattern: "(unclosed" });
  assert.equal(invalid.ok, false);
  const files = await call("find_files", { pattern: "**/*.ts" });
  assert.match(files.output, /main\.ts/);
  assert.match(files.output, /new\.ts/);
  const status = await call("git_status", {});
  assert.match(status.output, /\?\? new\.ts/);
  await call("read_file", { path: "util.ts" });
  await call("write_file", { path: "util.ts", content: "// changed\n" });
  const diff = await call("git_diff", {});
  assert.match(diff.output, /-\/\/ helper/);
  assert.match(diff.output, /\+\/\/ changed/);
  assert.match(diff.output, /new\.ts/);
});

test("shared notes are versioned and conflict-aware across agents", async () => {
  const { call } = await setup();
  assert.equal((await call("share_note", { key: "api", text: "v1 endpoint", kind: "decision" }, "alice")).ok, true);
  const conflict = await call("share_note", { key: "api", text: "v2 endpoint" }, "bob");
  assert.equal(conflict.ok, false);
  assert.match(conflict.output, /expected_version=1/);
  assert.equal((await call("share_note", { key: "api", text: "v2 endpoint", expected_version: 1 }, "bob")).ok, true);
  const stale = await call("share_note", { key: "api", text: "v3", expected_version: 1 }, "alice");
  assert.equal(stale.ok, false);
  const notes = await call("read_notes", { query: "endpoint" });
  assert.match(notes.output, /v2 endpoint/);
  assert.match(notes.output, /v2/);
  const project = await call("share_note", { key: "k", text: "t", scope: "project" });
  assert.equal(project.ok, false, "project memory is unavailable without a session");
});

test("project memory persists across stores and redacts secrets", async () => {
  const dir = await tempDir("mar-mem-");
  const file = join(dir, "memory.json");
  const { Redactor } = await import("../security/redact.js");
  const redactor = new Redactor(["hunter2-secret-value"]);
  const first = new MemoryStore("s1", file, redactor);
  await first.load();
  await first.write({ key: "db", text: "Use Postgres 16; password hunter2-secret-value", author: "master", kind: "decision", scope: "project" });
  const second = new MemoryStore("s2", file, redactor);
  await second.load();
  const entry = second.get("db", "project");
  assert.ok(entry);
  assert.equal(entry.sessionId, "s1");
  assert.doesNotMatch(entry.text, /hunter2/);
  assert.match(second.projectBrief(), /Postgres 16/);
});

test("check detection reads package.json scripts with the right package manager", async () => {
  const dir = await tempDir("mar-checks-");
  await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test", lint: "eslint .", start: "node ." } }));
  await writeFile(join(dir, "pnpm-lock.yaml"), "");
  const checks = await detectChecks(dir);
  assert.equal(checks.test, "pnpm run test");
  assert.equal(checks.lint, "pnpm run lint");
  assert.equal(checks.start, undefined);
});
