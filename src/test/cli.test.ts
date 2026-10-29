import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { cleanup, POSIX_ONLY, tempDir } from "./helpers.js";

const CLI = join(fileURLToPath(new URL(".", import.meta.url)), "..", "cli.js");
// Variables Windows needs for Node.js to start child processes and find temp/profile directories.
const WINDOWS_ENV = ["SystemRoot", "SYSTEMROOT", "windir", "ComSpec", "PATHEXT", "TEMP", "TMP"];
let home: string;
let pluginPath: string;

before(async () => {
  home = await tempDir("mar-cli-home-");
  pluginPath = join(home, "scripted.mjs");
  // A provider whose behavior is chosen by the task text, so each CLI run is deterministic.
  await writeFile(pluginPath, `
export default { apiVersion: 1, createProvider: () => ({ id: "scripted", async complete(request) {
  const task = request.messages.find((m) => m.role === "user")?.content ?? "";
  const results = request.messages.filter((m) => m.role === "tool");
  if (task.includes("WRITE") && !results.length) return { content: "", toolCalls: [{ id: "w", name: "write_file", arguments: { path: "out.txt", content: "from cli\\n" } }] };
  if (task.includes("COMMAND") && !results.length) return { content: "", toolCalls: [{ id: "c", name: "run_command", arguments: { argv: ["node", "-e", "require('fs').writeFileSync('ran.txt','x')"] } }] };
  if (task.includes("SECRET")) return { content: "the key is " + process.env.MAR_CLI_TEST_KEY, toolCalls: [] };
  if (task.includes("SLOW")) { await new Promise((resolve, reject) => { const t = setTimeout(resolve, 20000); request.signal?.addEventListener("abort", () => { clearTimeout(t); reject(Object.assign(new Error("aborted"), { name: "AbortError" })); }); }); }
  return { content: results.length ? "tool said: " + results.map((m) => m.content).join(" | ") : "done", toolCalls: [] };
} }) };
`);
});
after(cleanup);

interface Run { code: number | null; stdout: string }

function cli(args: string[], options: { cwd?: string; env?: Record<string, string>; killAfterMs?: number; interruptAfterMs?: number } = {}): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: options.cwd ?? home,
      env: {
        ...Object.fromEntries(WINDOWS_ENV.flatMap((name) => process.env[name] ? [[name, process.env[name]!]] : [])),
        PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, MAR_CONFIG_DIR: join(home, "config"), MAR_STATE_DIR: join(home, "state", "sessions"),
        NO_COLOR: "1", ...options.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stdout += chunk; });
    if (options.interruptAfterMs) setTimeout(() => child.kill("SIGINT"), options.interruptAfterMs);
    const timer = setTimeout(() => child.kill("SIGKILL"), options.killAfterMs ?? 20_000);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout }); });
    child.stdin.end();
  });
}

async function writeConfig(runtime: Record<string, unknown> = {}, version = 2): Promise<string> {
  const dir = join(home, "config");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "config.json");
  await writeFile(path, JSON.stringify({
    version,
    providers: { scripted: { kind: "plugin", module: pluginPath, apiKeyEnv: "MAR_CLI_TEST_KEY" } },
    team: { master: { name: "master", description: "m", provider: "scripted", model: "x" }, workers: [] },
    runtime: { approval: "on-request", commandTimeoutMs: 10_000, maxToolOutput: 10_000, plugins: [], ...runtime },
  }));
  return path;
}

test("help and version describe the new commands", async () => {
  const helpText = await cli(["--help"]);
  assert.equal(helpText.code, 0);
  for (const word of ["sessions", "resume", "--sandbox", "--approval", "--verify", "migrate"]) assert.match(helpText.stdout, new RegExp(word));
  const version = await cli(["--version"]);
  assert.equal(version.stdout.trim(), JSON.parse(await readFile(join(CLI, "..", "..", "package.json"), "utf8")).version);
});

test("config migrate upgrades a v1 file and keeps a backup", async () => {
  const path = await writeConfig({}, 1);
  const result = await cli(["config", "migrate"]);
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /from version 1 to 2/);
  assert.equal(JSON.parse(await readFile(path, "utf8")).version, 2);
  assert.equal(JSON.parse(await readFile(`${path}.v1.bak`, "utf8")).version, 1);
  assert.match((await cli(["config", "migrate"])).stdout, /already version 2/);
});

test("run --yes executes the tool loop, reports verification honestly, and records a session", async () => {
  await writeConfig();
  const workspace = await tempDir("mar-cli-ws-");
  const result = await cli(["run", "WRITE a file", "--yes", "--dir", workspace]);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(await readFile(join(workspace, "out.txt"), "utf8"), "from cli\n");
  assert.match(result.stdout, /Result: completed · verification unverified/);
  const id = result.stdout.match(/mar resume (\S+)/)?.[1];
  assert.ok(id);
  const list = await cli(["sessions"]);
  assert.match(list.stdout, new RegExp(`${id}\\s+completed`));
  const show = await cli(["sessions", "show", id]);
  assert.match(show.stdout, /message: \d+/);
  const deleted = await cli(["sessions", "delete", id]);
  assert.match(deleted.stdout, /Deleted session/);
  assert.doesNotMatch((await cli(["sessions"])).stdout, new RegExp(id));
});

test("without a terminal, approval-requiring calls are denied instead of hanging", async () => {
  await writeConfig();
  const workspace = await tempDir("mar-cli-deny-");
  const result = await cli(["run", "COMMAND please", "--dir", workspace], { killAfterMs: 15_000 });
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /approval needed but no interactive terminal/);
  assert.match(result.stdout, /user denied/);
  await assert.rejects(readFile(join(workspace, "ran.txt")), /ENOENT/);
});

test("read-only and auto-edit approval modes are enforced from the command line", async () => {
  await writeConfig();
  const workspace = await tempDir("mar-cli-ro-");
  const readOnly = await cli(["run", "WRITE something", "--read-only", "--dir", workspace]);
  assert.match(readOnly.stdout, /refused by policy/);
  await assert.rejects(readFile(join(workspace, "out.txt")), /ENOENT/);
  const autoEdit = await cli(["run", "WRITE something", "--approval", "auto-edit", "--dir", workspace]);
  assert.equal(await readFile(join(workspace, "out.txt"), "utf8"), "from cli\n");
  assert.equal(autoEdit.code, 0);
});

test("an unavailable sandbox backend fails closed", async () => {
  await writeConfig();
  const workspace = await tempDir("mar-cli-sbx-");
  const result = await cli(["run", "anything", "--yes", "--sandbox", "docker", "--dir", workspace], { env: { PATH: "/nonexistent" } });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /Sandbox backend "docker" is unavailable/);
});

test("secrets are redacted from output and doctor never prints key values", async () => {
  await writeConfig();
  const workspace = await tempDir("mar-cli-secret-");
  const secret = "sk-cli-test-0123456789abcdefghijklmnop";
  const run = await cli(["run", "SECRET", "--yes", "--dir", workspace], { env: { MAR_CLI_TEST_KEY: secret } });
  assert.doesNotMatch(run.stdout, /0123456789abcdefghijklmnop/);
  const doctor = await cli(["doctor", "--dir", workspace], { env: { MAR_CLI_TEST_KEY: secret } });
  assert.match(doctor.stdout, /MAR_CLI_TEST_KEY is set/);
  assert.doesNotMatch(doctor.stdout, /0123456789abcdefghijklmnop/);
  assert.match(doctor.stdout, /Sandbox bubblewrap/);
  const journalDir = join(home, "state", "sessions");
  const { readdir } = await import("node:fs/promises");
  for (const entry of await readdir(journalDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const journal = await readFile(join(journalDir, entry.name, "journal.jsonl"), "utf8").catch(() => "");
    assert.doesNotMatch(journal, /0123456789abcdefghijklmnop/);
  }
});

test("Ctrl+C cancels a running task and the session is resumable", { skip: POSIX_ONLY }, async () => {
  await writeConfig();
  const workspace = await tempDir("mar-cli-int-");
  const result = await cli(["run", "SLOW task", "--yes", "--dir", workspace], { interruptAfterMs: 1_500 });
  assert.equal(result.code, 130, result.stdout);
  assert.match(result.stdout, /Cancelling/);
  assert.match(result.stdout, /Result: cancelled/);
  const list = await cli(["sessions"]);
  assert.match(list.stdout, /interrupted/);
});
