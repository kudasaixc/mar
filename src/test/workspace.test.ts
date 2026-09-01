import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { Workspace } from "../tools/workspace.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; workspace: Workspace }> {
  const root = await mkdtemp(join(tmpdir(), "mar-test-"));
  temporary.push(root);
  await mkdir(join(root, "src"));
  return { root, workspace: await Workspace.create(root, 10_000, 5_000) };
}

test("workspace reads, writes, replaces, lists, and searches files", async () => {
  const { root, workspace } = await fixture();
  await workspace.write("src/index.ts", "export const answer = 41;\n");
  assert.match(await workspace.read("src/index.ts"), /1: export const answer/);
  await workspace.replace("src/index.ts", "41", "42");
  assert.equal(await readFile(join(root, "src/index.ts"), "utf8"), "export const answer = 42;\n");
  assert.match(await workspace.list(), /src\/index\.ts/);
  assert.match(await workspace.search("answer", "src"), /index\.ts:1/);
});

test("workspace blocks lexical and symlink escapes", async () => {
  const { root, workspace } = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "mar-outside-"));
  temporary.push(outside);
  await writeFile(join(outside, "secret"), "nope");
  await symlink(outside, join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(() => workspace.read("../secret"), /escapes the workspace/);
  await assert.rejects(() => workspace.read("escape/secret"), /Symlink escapes/);
});

test("workspace baseline policy blocks destructive recursive force", async () => {
  const { workspace } = await fixture();
  await assert.rejects(() => workspace.run("rm -rf ./src"), /blocked/);
});

test("workspace search falls back when ripgrep is unavailable", async () => {
  const { workspace } = await fixture();
  await workspace.write("src/fallback.ts", "const portableSearch = true;\n");
  const originalPath = process.env.PATH;
  process.env.PATH = "";
  try {
    assert.match(await workspace.search("portableSearch", ".", "*.ts"), /src\/fallback\.ts:1/);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});
