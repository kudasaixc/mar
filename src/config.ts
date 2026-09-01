import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ConfigurationError } from "./errors.js";
import type { AgentProfile, MarConfig, ProviderConfig } from "./types.js";

const CONFIG_DIR = process.env.MAR_CONFIG_DIR
  ? resolve(process.env.MAR_CONFIG_DIR)
  : join(homedir(), ".config", "mar");

export const GLOBAL_CONFIG_PATH = join(CONFIG_DIR, "config.json");

export function defaultConfig(): MarConfig {
  return {
    version: 1,
    providers: {
      ollama: { kind: "ollama", baseUrl: "http://localhost:11434" },
    },
    team: {
      master: {
        name: "architect",
        description: "Plans, delegates, integrates, and verifies the work.",
        provider: "ollama",
        model: "qwen3-coder",
        maxTokens: 8192,
        maxTurns: 30,
      },
      workers: [],
    },
    runtime: {
      approval: "on-request",
      commandTimeoutMs: 120_000,
      maxToolOutput: 30_000,
      plugins: [],
    },
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateProvider(id: string, value: unknown): asserts value is ProviderConfig {
  if (!isRecord(value)) throw new ConfigurationError(`Provider "${id}" must be an object.`);
  const kinds = ["openai-compatible", "anthropic", "gemini", "ollama", "plugin"];
  if (typeof value.kind !== "string" || !kinds.includes(value.kind)) {
    throw new ConfigurationError(`Provider "${id}" has an unsupported kind.`);
  }
  if (value.kind === "plugin" && typeof value.module !== "string") {
    throw new ConfigurationError(`Plugin provider "${id}" requires a module path.`);
  }
  if (value.apiKeyEnv !== undefined && typeof value.apiKeyEnv !== "string") {
    throw new ConfigurationError(`Provider "${id}" apiKeyEnv must be a string.`);
  }
}

function validateAgent(value: unknown, label: string, providers: Record<string, ProviderConfig>): asserts value is AgentProfile {
  if (!isRecord(value)) throw new ConfigurationError(`${label} must be an object.`);
  for (const field of ["name", "description", "provider", "model"] as const) {
    if (typeof value[field] !== "string" || value[field].trim() === "") {
      throw new ConfigurationError(`${label}.${field} must be a non-empty string.`);
    }
  }
  if (!providers[value.provider as string]) {
    throw new ConfigurationError(`${label} references unknown provider "${String(value.provider)}".`);
  }
  if (value.fallbacks !== undefined && !Array.isArray(value.fallbacks)) {
    throw new ConfigurationError(`${label}.fallbacks must be an array.`);
  }
}

export function validateConfig(value: unknown): MarConfig {
  if (!isRecord(value) || value.version !== 1) {
    throw new ConfigurationError("Unsupported or missing MAR config version (expected 1).");
  }
  if (!isRecord(value.providers) || Object.keys(value.providers).length === 0) {
    throw new ConfigurationError("At least one provider is required.");
  }
  for (const [id, provider] of Object.entries(value.providers)) validateProvider(id, provider);
  if (!isRecord(value.team) || !Array.isArray(value.team.workers)) {
    throw new ConfigurationError("team.master and team.workers are required.");
  }
  validateAgent(value.team.master, "team.master", value.providers as Record<string, ProviderConfig>);
  const names = new Set<string>([(value.team.master as AgentProfile).name]);
  value.team.workers.forEach((worker, index) => {
    validateAgent(worker, `team.workers[${index}]`, value.providers as Record<string, ProviderConfig>);
    if (names.has(worker.name)) throw new ConfigurationError(`Agent name "${worker.name}" is duplicated.`);
    names.add(worker.name);
  });
  if (!isRecord(value.runtime)) throw new ConfigurationError("runtime settings are required.");
  if (!["on-request", "never", "read-only"].includes(String(value.runtime.approval))) {
    throw new ConfigurationError("runtime.approval must be on-request, never, or read-only.");
  }
  if (!Array.isArray(value.runtime.plugins)) value.runtime.plugins = [];
  if (!Number.isFinite(value.runtime.commandTimeoutMs)) value.runtime.commandTimeoutMs = 120_000;
  if (!Number.isFinite(value.runtime.maxToolOutput)) value.runtime.maxToolOutput = 30_000;
  return value as unknown as MarConfig;
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new ConfigurationError(`Invalid JSON in ${path}: ${error.message}`);
    throw error;
  }
}

function mergeConfig(base: MarConfig, project: Partial<MarConfig>): MarConfig {
  return {
    ...base,
    ...project,
    providers: { ...base.providers, ...(project.providers ?? {}) },
    team: { ...base.team, ...(project.team ?? {}) },
    runtime: { ...base.runtime, ...(project.runtime ?? {}) },
  } as MarConfig;
}

export async function findProjectConfig(workspace: string): Promise<string | undefined> {
  let current = resolve(workspace);
  for (;;) {
    const candidate = join(current, "mar.config.json");
    if (await exists(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export async function loadConfig(workspace = process.cwd(), explicitPath?: string): Promise<{ config: MarConfig; paths: string[] }> {
  const globalPath = explicitPath ? resolve(explicitPath) : GLOBAL_CONFIG_PATH;
  if (!(await exists(globalPath))) {
    throw new ConfigurationError(`No configuration found at ${globalPath}. Run \"mar init\" first.`);
  }
  let config = validateConfig(await readJson(globalPath));
  const paths = [globalPath];
  if (!explicitPath) {
    const projectPath = await findProjectConfig(workspace);
    if (projectPath && projectPath !== globalPath) {
      config = validateConfig(mergeConfig(config, (await readJson(projectPath)) as Partial<MarConfig>));
      paths.push(projectPath);
    }
  }
  return { config, paths };
}

export async function saveConfig(config: MarConfig, path = GLOBAL_CONFIG_PATH): Promise<void> {
  validateConfig(config);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

export async function hasConfig(): Promise<boolean> {
  return exists(GLOBAL_CONFIG_PATH);
}
