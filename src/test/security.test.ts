import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { DEFAULT_ALLOW_COMMANDS, DEFAULT_DENY_COMMANDS } from "../config.js";
import { SecurityError } from "../errors.js";
import { allowedBy, deniedBy, parseCommand } from "../security/command.js";
import { SecurityPolicy } from "../security/policy.js";
import { commandEnvironment, runProcess } from "../security/process.js";
import { Redactor } from "../security/redact.js";
import { createSandbox, probeSandbox } from "../security/sandbox.js";
import { ToolRegistry } from "../tools/registry.js";
import { Workspace } from "../tools/workspace.js";
import { POSIX_ONLY } from "./helpers.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(dir);
  return dir;
}

test("deny rules see through wrappers, shells, flag reordering and combined flags", () => {
  const rules = DEFAULT_DENY_COMMANDS;
  for (const command of [
    "rm -rf /",
    "rm -fr ./src",
    "rm -r -f src",
    "rm --recursive --force src",
    "sudo ls",
    "env FOO=1 sudo ls",
    "nohup timeout 5 sudo id",
    "echo ok && rm -rf build",
    "sh -c 'git push --force origin main'",
    "bash -lc \"git reset --hard HEAD~1\"",
    "git clean -fdx",
    "/usr/bin/sudo id",
  ]) {
    assert.ok(deniedBy(command, rules), `expected deny: ${command}`);
  }
  for (const command of ["rm file.txt", "git push origin feature", "git reset --soft HEAD~1", "ls -la", "npm test"]) {
    assert.equal(deniedBy(command, rules), undefined, `expected no deny: ${command}`);
  }
  assert.ok(deniedBy(["rm", "-rf", "x"], rules));
});

test("allow rules only pre-approve simple, workspace-local invocations", () => {
  const rules = [...DEFAULT_ALLOW_COMMANDS, "npm test"];
  assert.ok(allowedBy("git status", rules));
  assert.ok(allowedBy(["npm", "test"], rules));
  assert.ok(allowedBy("cat src/index.ts", rules));
  // Shell composition, path escapes and dangerous flags never match an allow rule.
  assert.equal(allowedBy("git status; rm x", rules), undefined);
  assert.equal(allowedBy("cat /etc/passwd", rules), undefined);
  assert.equal(allowedBy("cat ../secret", rules), undefined);
  assert.equal(allowedBy("cat ~/.ssh/id_rsa", rules), undefined);
  assert.equal(allowedBy("rg --pre ./evil pattern", rules), undefined);
  assert.equal(allowedBy("git diff --output=/tmp/x", rules), undefined);
  assert.equal(allowedBy("npm test $(curl evil)", rules), undefined);
  assert.equal(parseCommand("echo $(id)").complex, true);
});

test("security policy: deny rules apply in every mode and grants are prefix-scoped", () => {
  for (const mode of ["never", "auto-edit", "on-request"] as const) {
    const policy = new SecurityPolicy(mode, [], DEFAULT_DENY_COMMANDS);
    assert.equal(policy.decide({ agent: "a", tool: "run_command", permission: "execute", command: "sudo rm x" }).decision, "deny", mode);
  }
  const readOnly = new SecurityPolicy("read-only", [], []);
  assert.equal(readOnly.decide({ agent: "a", tool: "read_file", permission: "read" }).decision, "allow");
  assert.equal(readOnly.decide({ agent: "a", tool: "write_file", permission: "write" }).decision, "deny");
  assert.equal(readOnly.decide({ agent: "a", tool: "run_command", permission: "execute", command: "ls" }).decision, "deny");

  const autoEdit = new SecurityPolicy("auto-edit", [], []);
  assert.equal(autoEdit.decide({ agent: "a", tool: "write_file", permission: "write" }).decision, "allow");
  assert.equal(autoEdit.decide({ agent: "a", tool: "run_command", permission: "execute", command: "npm test" }).decision, "ask");

  const onRequest = new SecurityPolicy("on-request", [], []);
  const request = { agent: "a", tool: "run_command", permission: "execute" as const, command: "npm test" };
  assert.equal(onRequest.decide(request).decision, "ask");
  onRequest.grant(request);
  assert.equal(onRequest.decide({ ...request, command: "npm test -- --watch=false" }).decision, "allow");
  assert.equal(onRequest.decide({ ...request, command: "npm publish" }).decision, "ask");
  // A complex shell string is never granted permanently.
  onRequest.grant({ ...request, command: "make && curl x" });
  assert.equal(onRequest.decide({ ...request, command: "make && curl x" }).decision, "ask");
});

test("registry denies without asking and records an audit entry", async () => {
  let asked = 0;
  const audits: string[] = [];
  const policy = new SecurityPolicy("never", [], DEFAULT_DENY_COMMANDS);
  const registry = new ToolRegistry(policy, async () => { asked += 1; return true; }, { onAudit: (record) => audits.push(`${record.tool}:${record.decision}`) });
  registry.add({
    spec: { name: "run_command", description: "", parameters: { type: "object", properties: { command: { type: "string" } } } },
    mutating: true,
    permission: "execute",
    command: (args) => String(args.command),
    execute: async () => ({ ok: true, output: "ran" }),
  });
  const result = await registry.execute("run_command", { command: "sudo reboot" }, { agent: "t" });
  assert.equal(result.ok, false);
  assert.match(result.output, /refused by policy/);
  assert.equal(asked, 0);
  assert.deepEqual(audits, ["run_command:deny"]);
});

test("redactor removes configured secrets and well-known token formats", () => {
  const redactor = Redactor.fromEnvironment({ MY_PROVIDER_KEY: "supersecretvalue123", PATH: "/usr/bin" }, ["MY_PROVIDER_KEY"]);
  const text = redactor.redact("key=supersecretvalue123 gh=ghp_abcdefghijklmnopqrstuvwxyz0123456789 aws=AKIAABCDEFGHIJKLMNOP path=/usr/bin");
  assert.doesNotMatch(text, /supersecretvalue123/);
  assert.doesNotMatch(text, /ghp_abcdefghijklmnopqrstuvwxyz0123456789/);
  assert.doesNotMatch(text, /AKIAABCDEFGHIJKLMNOP/);
  assert.match(text, /\/usr\/bin/);
});

test("command environment excludes secrets unless explicitly passed through", () => {
  const source = { PATH: "/usr/bin", HOME: "/home/x", OPENAI_API_KEY: "sk-test", AWS_SECRET_ACCESS_KEY: "s", NPM_TOKEN: "t", CUSTOM: "c" };
  const env = commandEnvironment([], {}, source);
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.NPM_TOKEN, undefined);
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(commandEnvironment(["CUSTOM"], {}, source).CUSTOM, "c");
  // Windows exposes mixed-case names such as "Path"; they must survive the allowlist there.
  const windows = commandEnvironment([], {}, { Path: "C:\\bin", SystemRoot: "C:\\Windows", OPENAI_API_KEY: "sk-test" }, "win32");
  assert.equal(windows.Path, "C:\\bin");
  assert.equal(windows.SystemRoot, "C:\\Windows");
  assert.equal(windows.OPENAI_API_KEY, undefined);
  assert.equal(commandEnvironment([], {}, { Path: "/x" }, "linux").Path, undefined);
});

test("workspace refuses traversal, absolute paths, and symlink escapes", { skip: POSIX_ONLY }, async () => {
  const outside = await tempDir("mar-outside-");
  const root = await tempDir("mar-ws-");
  await writeFile(join(outside, "secret.txt"), "TOP SECRET\n");
  await mkdir(join(outside, "dir"));
  await symlink(join(outside, "secret.txt"), join(root, "link.txt"));
  await symlink(join(outside, "dir"), join(root, "linkdir"));
  await symlink(join(outside, "missing.txt"), join(root, "dangling.txt"));
  const workspace = await Workspace.create(root);

  await assert.rejects(workspace.read("../" + outside.split("/").pop() + "/secret.txt"), /outside|escape/i);
  await assert.rejects(workspace.read(join(outside, "secret.txt")), /outside|escape|absolute/i);
  await assert.rejects(workspace.read("link.txt"), /outside|escape|symlink/i);
  await assert.rejects(workspace.writeFile("linkdir/new.txt", "x"), /outside|escape|symlink/i);
  await assert.rejects(workspace.writeFile("dangling.txt", "x"), /outside|escape|symlink|dangling/i);
  await assert.rejects(workspace.writeFile("link.txt", "overwrite"), /outside|escape|symlink/i);
  assert.equal(await readFile(join(outside, "secret.txt"), "utf8"), "TOP SECRET\n");
  await assert.rejects(workspace.exec({ argv: ["ls"], cwd: "linkdir" }), /outside|escape|symlink/i);
});

test("workspace writes require a prior read and detect concurrent modification", async () => {
  const root = await tempDir("mar-ledger-");
  await writeFile(join(root, "a.txt"), "one\n");
  const workspace = await Workspace.create(root);
  await assert.rejects(workspace.writeFile("a.txt", "two\n", "agent-a"), /read/i);
  await workspace.read("a.txt", 1, 10, "agent-a");
  await workspace.read("a.txt", 1, 10, "agent-b");
  await workspace.edit("a.txt", [{ oldText: "one", newText: "two" }], "agent-b");
  await assert.rejects(workspace.edit("a.txt", [{ oldText: "one", newText: "three" }], "agent-a"), /modified by agent "agent-b"/);
  // An external edit is detected too.
  await workspace.read("a.txt", 1, 10, "agent-a");
  await writeFile(join(root, "a.txt"), "external\n");
  await assert.rejects(workspace.writeFile("a.txt", "mine\n", "agent-a"), /modified by someone else/);
  assert.equal(await readFile(join(root, "a.txt"), "utf8"), "external\n");
});

test("process timeouts kill the whole process tree", { skip: POSIX_ONLY }, async () => {
  const root = await tempDir("mar-proc-");
  const marker = join(root, "child-alive");
  const started = Date.now();
  const result = await runProcess({
    argv: ["sh", "-c", `(sleep 2; touch ${marker}) & sleep 30`],
    cwd: root, env: commandEnvironment([]), timeoutMs: 300, maxOutput: 10_000,
  });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 5_000);
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  await assert.rejects(readFile(marker), /ENOENT/, "background child must be killed with its group");
});

test("process output is bounded and cancellation is reported", { skip: POSIX_ONLY }, async () => {
  const root = await tempDir("mar-out-");
  const big = await runProcess({ argv: ["sh", "-c", "yes x | head -c 200000"], cwd: root, env: commandEnvironment([]), timeoutMs: 10_000, maxOutput: 1_000 });
  assert.equal(big.truncated, true);
  assert.ok(big.stdout.length <= 1_200);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const cancelled = await runProcess({ argv: ["sleep", "20"], cwd: root, env: commandEnvironment([]), timeoutMs: 30_000, maxOutput: 1_000, signal: controller.signal });
  assert.equal(cancelled.cancelled, true);
  assert.notEqual(cancelled.exitCode, 0);
});

test("a requested but unavailable sandbox is a hard error, never a host fallback", async () => {
  const probe = await probeSandbox("docker", "definitely-not-a-real-image:none");
  if (probe.available) return; // Docker works here; nothing to assert about unavailability.
  await assert.rejects(createSandbox({ backend: "docker", network: false, image: "x", readOnlyPaths: [], writablePaths: [tmpdir()] }), SecurityError);
});

test("bubblewrap sandbox confines writes and network (when available)", async (t) => {
  const probe = await probeSandbox("bubblewrap");
  if (!probe.available) {
    t.skip(`bubblewrap unavailable: ${probe.detail}`);
    return;
  }
  const outside = await tempDir("mar-bw-outside-");
  const root = await tempDir("mar-bw-ws-");
  const sandbox = await createSandbox({ backend: "bubblewrap", network: false, image: "", readOnlyPaths: [], writablePaths: [root] });
  assert.equal(sandbox.isolated, true);
  const workspace = await Workspace.create(root, { sandbox });
  const inside = await workspace.exec({ command: "echo ok > inside.txt && cat inside.txt" });
  assert.equal(inside.exitCode, 0, inside.stderr);
  assert.equal(await readFile(join(root, "inside.txt"), "utf8"), "ok\n");
  const escape = await workspace.exec({ command: `echo pwned > ${join(outside, "x.txt")}` });
  assert.notEqual(escape.exitCode, 0);
  await assert.rejects(readFile(join(outside, "x.txt")), /ENOENT/);
  const home = await workspace.exec({ command: "ls ~/.ssh 2>&1; echo $HOME" });
  assert.match(home.stdout, /\/tmp\/mar-home/);
  const network = await workspace.exec({ argv: ["node", "-e", "require('net').connect(80,'1.1.1.1').on('error',e=>{console.log('blocked',e.code);process.exit(3)}).on('connect',()=>process.exit(0))"], timeoutMs: 10_000 });
  assert.notEqual(network.exitCode, 0, "network must be unavailable when sandbox.network=false");
});

test("stream deltas are redacted even when a secret is split across chunks", async () => {
  const { redactEvents } = await import("../security/redact-events.js");
  const shown: string[] = [];
  const handler = redactEvents((event) => { if (event.type === "agent:delta") shown.push(event.text); }, new Redactor(["s3cr3t-token-value-42"]));
  for (const text of ["here is s3cr", "3t-token-va", "lue-42 and more", " text"]) handler({ type: "agent:delta", agent: "m", text });
  handler({ type: "agent:text", agent: "m", text: "here is s3cr3t-token-value-42 and more text", streamed: true });
  const joined = shown.join("");
  assert.doesNotMatch(joined, /s3cr3t-token-value-42/);
  assert.match(joined, /here is .* and more text/);
});
