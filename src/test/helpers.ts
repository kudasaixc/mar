import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompletionRequest, CompletionResponse, ModelAdapter, ModelCapabilities } from "../types.js";
import { resolveCapabilities } from "../providers/capabilities.js";
import type { ProviderRegistry } from "../providers/registry.js";

export type Script = (request: CompletionRequest) => CompletionResponse | Promise<CompletionResponse>;

declare global {
  // eslint-disable-next-line no-var
  var __marFakeProvider: Script | undefined;
}

const temporary: string[] = [];

export async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(dir);
  return dir;
}

export async function cleanup(): Promise<void> {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
}

/** Writes a provider plugin that forwards every request to `globalThis.__marFakeProvider`. */
export async function fakeProviderModule(dir: string): Promise<string> {
  const path = join(dir, "fake-provider.mjs");
  await writeFile(path, `export default { apiVersion: 1, createProvider: () => ({ id: "fake", complete: (request) => globalThis.__marFakeProvider(request) }) };\n`);
  return path;
}

export function setScript(script: Script): void {
  globalThis.__marFakeProvider = script;
}

export function config(module: string, workers: string[] = [], runtime: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 2,
    providers: { fake: { kind: "plugin", module } },
    team: {
      master: { name: "master", description: "test master", provider: "fake", model: "master" },
      workers: workers.map((name) => ({ name, description: `worker ${name}`, provider: "fake", model: `worker-${name}` })),
    },
    runtime: { approval: "never", commandTimeoutMs: 10_000, maxToolOutput: 20_000, plugins: [], stream: false, ...runtime },
  };
}

/** Minimal registry for AgentRuntime unit tests. */
export function registryFor(adapters: Record<string, ModelAdapter>, capabilities: Partial<ModelCapabilities> = {}): ProviderRegistry {
  return {
    get: (id: string) => {
      const adapter = adapters[id];
      if (!adapter) throw new Error(`unknown provider ${id}`);
      return adapter;
    },
    capabilities: (_id: string, model: string, override?: Partial<ModelCapabilities>) => resolveCapabilities("plugin", model, capabilities, override),
    streams: () => true,
  } as unknown as ProviderRegistry;
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd, encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
}

export async function gitRepo(files: Record<string, string>): Promise<string> {
  const root = await tempDir("mar-git-");
  git(root, "init", "-q", "-b", "main");
  // Keep fixtures byte-exact on Windows runners, where Git defaults to core.autocrlf=true.
  git(root, "config", "core.autocrlf", "false");
  for (const [path, content] of Object.entries(files)) await writeFile(join(root, path), content);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  return root;
}

export const lastUser = (request: CompletionRequest): string =>
  [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "";

export const toolResults = (request: CompletionRequest) => request.messages.filter((message) => message.role === "tool");

/** Skip reason for tests that rely on a POSIX shell, symlinks, process groups, or signals. */
export const POSIX_ONLY: string | false = process.platform === "win32" ? "relies on POSIX shell utilities, symlinks, or signals" : false;

/** argv running a Node.js snippet, portable across platforms. */
export function nodeArgv(code: string): string[] {
  return [process.execPath, "-e", code];
}
