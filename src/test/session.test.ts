import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Orchestrator } from "../runtime/orchestrator.js";
import { repairToolHistory, SessionStore } from "../session/store.js";
import { cleanup, config, fakeProviderModule, lastUser, setScript, tempDir } from "./helpers.js";

let state: string;
let module: string;
before(async () => {
  state = await tempDir("mar-state-");
  process.env.MAR_STATE_DIR = join(state, "sessions");
  module = await fakeProviderModule(state);
});
after(cleanup);

test("a session persists the conversation and resumes it in a new process-equivalent", async () => {
  const workspace = await tempDir("mar-ws-");
  setScript((request) => ({ content: `answer to: ${lastUser(request)}`, toolCalls: [] }));
  const session = await SessionStore.create(workspace, { title: "" });
  const first = await Orchestrator.create({ config: config(module), workspace, approve: async () => true, session });
  assert.equal(await first.run("remember the codeword PELICAN"), "answer to: remember the codeword PELICAN");
  await first.close("completed");

  const listed = await SessionStore.list();
  const entry = listed.find((item) => item.id === session.metadata.id);
  assert.ok(entry);
  assert.equal(entry.status, "completed");
  assert.match(entry.title, /PELICAN/);

  const reopened = await SessionStore.open(session.metadata.id.slice(0, 12));
  const recovered = await reopened.recover("master");
  let seen = "";
  setScript((request) => {
    seen = request.messages.map((message) => message.content).join("\n");
    return { content: "resumed", toolCalls: [] };
  });
  const second = await Orchestrator.create({ config: config(module), workspace, approve: async () => true, session: reopened, recovered });
  assert.equal(await second.run("what was the codeword?"), "resumed");
  assert.match(seen, /PELICAN/);
  assert.match(seen, /answer to: remember the codeword PELICAN/);
  await second.close("completed");
});

test("crash recovery inserts synthetic results and never replays interrupted tools", async () => {
  const workspace = await tempDir("mar-crash-");
  const session = await SessionStore.create(workspace);
  await session.append("message", { role: "user", content: "write the file" }, "master");
  await session.append("message", {
    role: "assistant", content: "",
    toolCalls: [{ id: "w1", name: "write_file", arguments: { path: "a.txt", content: "x" } }, { id: "w2", name: "run_command", arguments: { argv: ["npm", "test"] } }],
  }, "master");
  await session.append("tool:start", { callId: "w1", name: "write_file" }, "master");
  await session.flush();
  // Simulate a crash: a torn final line and no clean close (the lock file stays behind).
  await appendFile(join(process.env.MAR_STATE_DIR!, session.metadata.id, "journal.jsonl"), '{"seq":99,"type":"mess');

  const listing = (await SessionStore.list()).find((item) => item.id === session.metadata.id)!;
  assert.ok(listing.status === "active" || listing.status === "interrupted");
  // A fresh process can take over a session whose owner died; within this process the lock is live, so release it first.
  await session.close("interrupted");
  const reopened = await SessionStore.open(session.metadata.id);
  const recovered = await reopened.recover("master");
  assert.equal(recovered.corruptRecords, 1);
  assert.deepEqual(recovered.interruptedCalls.map((call) => [call.id, call.started]), [["w1", true], ["w2", false]]);
  const results = recovered.messages.filter((message) => message.role === "tool");
  assert.equal(results.length, 2);
  assert.match(results[0]!.content, /INTERRUPTED/);
  assert.match(results[1]!.content, /NOT EXECUTED/);

  let executedTools = 0;
  setScript((request) => {
    executedTools = request.messages.filter((message) => message.role === "tool").length;
    return { content: "checked state instead of replaying", toolCalls: [] };
  });
  const runtime = await Orchestrator.create({ config: config(module), workspace, approve: async () => true, session: reopened, recovered });
  await runtime.run("continue");
  assert.equal(executedTools, 2, "only the synthetic results are present");
  await assert.rejects(readFile(join(workspace, "a.txt")), /ENOENT/, "the interrupted write was not replayed");
  await runtime.close("completed");
});

test("locked sessions cannot be opened twice or deleted; unlocked ones can be deleted", async () => {
  const workspace = await tempDir("mar-lock-");
  const session = await SessionStore.create(workspace);
  await assert.rejects(SessionStore.open(session.metadata.id), /already open/i);
  await assert.rejects(SessionStore.delete(session.metadata.id), /in use|locked|running/i);
  await session.close("completed");
  assert.equal(await SessionStore.delete(session.metadata.id), session.metadata.id);
  assert.equal((await SessionStore.list()).some((item) => item.id === session.metadata.id), false);
});

test("legacy 0.1 JSONL sessions are listed and converted on resume without touching the original", async () => {
  const root = process.env.MAR_STATE_DIR!;
  await mkdir(root, { recursive: true });
  const id = "2025-01-01T00-00-00-000Z-abcdef12";
  const legacyText = [
    { timestamp: "2025-01-01T00:00:00.000Z", type: "session:start", data: { workspace: "/tmp/legacy", marVersion: "0.1.0" } },
    { timestamp: "2025-01-01T00:00:01.000Z", type: "user:task", data: { task: "old task" } },
    { timestamp: "2025-01-01T00:00:02.000Z", type: "assistant:result", data: { result: "old answer" } },
  ].map((line) => JSON.stringify(line)).join("\n") + "\n";
  await writeFile(join(root, `${id}.jsonl`), legacyText);
  const listing = (await SessionStore.list()).find((item) => item.id === id);
  assert.ok(listing?.legacy);
  assert.equal(listing.title, "old task");
  const session = await SessionStore.open(id);
  const recovered = await session.recover("master");
  assert.deepEqual(recovered.messages.map((message) => [message.role, message.content]), [["user", "old task"], ["assistant", "old answer"]]);
  await session.close("completed");
  assert.equal(await readFile(join(root, `${id}.jsonl`), "utf8"), legacyText);
  assert.ok((await readdir(root)).includes(id));
});

test("secrets are redacted before they reach the journal", async () => {
  const workspace = await tempDir("mar-redact-");
  process.env.MAR_TEST_SECRET_KEY = "sk-live-abcdefghijklmnopqrstuvwxyz123456";
  try {
    const { Redactor } = await import("../security/redact.js");
    const session = await SessionStore.create(workspace, { redactor: Redactor.fromEnvironment(process.env, ["MAR_TEST_SECRET_KEY"]) });
    await session.append("message", { role: "tool", content: `token is ${process.env.MAR_TEST_SECRET_KEY}` }, "master");
    await session.close("completed");
    const journal = await readFile(join(process.env.MAR_STATE_DIR!, session.metadata.id, "journal.jsonl"), "utf8");
    assert.doesNotMatch(journal, /abcdefghijklmnopqrstuvwxyz123456/);
  } finally {
    delete process.env.MAR_TEST_SECRET_KEY;
  }
});

test("repairToolHistory leaves complete histories unchanged", () => {
  const messages = [
    { role: "user" as const, content: "x" },
    { role: "assistant" as const, content: "", toolCalls: [{ id: "a", name: "read_file", arguments: {} }] },
    { role: "tool" as const, content: "ok", toolCallId: "a" },
  ];
  const repaired = repairToolHistory(messages);
  assert.deepEqual(repaired.messages, messages);
  assert.equal(repaired.interrupted.length, 0);
});
