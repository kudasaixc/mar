import type { Interface } from "node:readline/promises";
import { stdout } from "node:process";
import { GLOBAL_CONFIG_PATH, saveConfig } from "../config.js";
import type { AgentProfile, MarConfig, ProviderConfig } from "../types.js";
import { banner, colors } from "./terminal.js";

interface ProviderPreset {
  label: string;
  id: string;
  config: ProviderConfig;
  modelHint: string;
}

const PRESETS: ProviderPreset[] = [
  { label: "OpenAI", id: "openai", config: { kind: "openai-compatible", baseUrl: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY" }, modelHint: "enter an OpenAI model ID" },
  { label: "Anthropic", id: "anthropic", config: { kind: "anthropic", baseUrl: "https://api.anthropic.com/v1", apiKeyEnv: "ANTHROPIC_API_KEY" }, modelHint: "enter a Claude model ID" },
  { label: "Google Gemini", id: "gemini", config: { kind: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", apiKeyEnv: "GEMINI_API_KEY" }, modelHint: "enter a Gemini model ID" },
  { label: "Ollama (local)", id: "ollama", config: { kind: "ollama", baseUrl: "http://localhost:11434" }, modelHint: "e.g. qwen3-coder" },
  { label: "OpenRouter", id: "openrouter", config: { kind: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY" }, modelHint: "e.g. provider/model" },
  { label: "Custom OpenAI-compatible endpoint", id: "custom", config: { kind: "openai-compatible" }, modelHint: "model ID exposed by your endpoint" },
];

async function ask(terminal: Interface, question: string, fallback?: string): Promise<string> {
  for (;;) {
    const suffix = fallback ? ` ${colors.gray(`[${fallback}]`)}` : "";
    const answer = (await terminal.question(`${question}${suffix}: `)).trim();
    if (answer) return answer;
    if (fallback !== undefined) return fallback;
  }
}

async function choose(terminal: Interface, question: string, labels: string[]): Promise<number> {
  stdout.write(`\n${question}\n`);
  labels.forEach((label, index) => stdout.write(`  ${colors.cyan(String(index + 1))}. ${label}\n`));
  for (;;) {
    const raw = await terminal.question("Choice: ");
    const selected = Number.parseInt(raw, 10) - 1;
    if (selected >= 0 && selected < labels.length) return selected;
    stdout.write(colors.red(`Enter a number from 1 to ${labels.length}.\n`));
  }
}

async function configureProvider(terminal: Interface, providers: Record<string, ProviderConfig>): Promise<{ id: string; modelHint: string }> {
  const preset = PRESETS[await choose(terminal, "Which provider should this agent use?", PRESETS.map((item) => item.label))]!;
  let id = await ask(terminal, "Provider alias", preset.id);
  if (providers[id]) {
    const reuse = await ask(terminal, `Alias "${id}" already exists. Reuse it?`, "yes");
    if (/^(y|yes|o|oui)$/i.test(reuse)) return { id, modelHint: preset.modelHint };
    id = await ask(terminal, "New provider alias");
  }
  const config: ProviderConfig = { ...preset.config };
  if (preset.id === "custom") {
    config.baseUrl = await ask(terminal, "Base URL (including /v1 if required)");
    const env = await ask(terminal, "API-key environment variable (blank means none)", "");
    if (env) config.apiKeyEnv = env;
  }
  providers[id] = config;
  return { id, modelHint: preset.modelHint };
}

async function configureAgent(
  terminal: Interface,
  providers: Record<string, ProviderConfig>,
  role: "master" | "worker",
  index = 0,
): Promise<AgentProfile> {
  let providerId: string;
  let modelHint = "model ID";
  const ids = Object.keys(providers);
  if (ids.length) {
    const options = [...ids.map((id) => `Reuse ${id} (${providers[id]!.kind})`), "Add another provider"];
    const selected = await choose(terminal, `${role === "master" ? "Master" : `Worker ${index}`} provider`, options);
    if (selected < ids.length) providerId = ids[selected]!;
    else ({ id: providerId, modelHint } = await configureProvider(terminal, providers));
  } else {
    ({ id: providerId, modelHint } = await configureProvider(terminal, providers));
  }
  const defaultName = role === "master" ? "architect" : `worker-${index}`;
  const name = await ask(terminal, "Agent name", defaultName);
  const model = await ask(terminal, `Model (${modelHint})`);
  const defaultDescription = role === "master"
    ? "Plans, delegates, integrates, and verifies the work."
    : "Implements and verifies delegated coding tasks.";
  const description = await ask(terminal, "Agent specialty", defaultDescription);
  return { name, description, provider: providerId, model, maxTokens: 8192, maxTurns: 30 };
}

export async function runOnboarding(terminal: Interface): Promise<MarConfig> {
  stdout.write(`\n${banner()}\n${colors.bold("Build your model team in a minute.")}\n`);
  stdout.write(`${colors.gray("Keys remain in environment variables; MAR only stores their names.")}\n`);
  const providers: Record<string, ProviderConfig> = {};

  stdout.write(`\n${colors.bold("1/3 — Master model")}\n`);
  const master = await configureAgent(terminal, providers, "master");

  stdout.write(`\n${colors.bold("2/3 — Worker models")}\n`);
  const countRaw = await ask(terminal, "How many workers? (0-8)", "2");
  const count = Math.min(8, Math.max(0, Number.parseInt(countRaw, 10) || 0));
  const workers: AgentProfile[] = [];
  for (let index = 1; index <= count; index += 1) {
    workers.push(await configureAgent(terminal, providers, "worker", index));
  }

  stdout.write(`\n${colors.bold("3/3 — Safety")}\n`);
  const approvalChoice = await choose(terminal, "When may agents change files or run commands?", [
    "Ask before every mutating tool call (recommended)",
    "Autonomous — allow tool calls without prompts",
    "Read-only — never change the workspace",
  ]);
  const approval = (["on-request", "never", "read-only"] as const)[approvalChoice]!;
  const config: MarConfig = {
    version: 1,
    providers,
    team: { master, workers },
    runtime: { approval, commandTimeoutMs: 120_000, maxToolOutput: 30_000, plugins: [] },
  };
  await saveConfig(config);
  stdout.write(`\n${colors.green("✓ Team configured")} at ${GLOBAL_CONFIG_PATH}\n`);
  for (const [id, provider] of Object.entries(providers)) {
    if (provider.apiKeyEnv && !process.env[provider.apiKeyEnv]) {
      stdout.write(`${colors.yellow("!")} Set ${provider.apiKeyEnv} before using provider ${id}.\n`);
    }
  }
  stdout.write(`\nRun ${colors.cyan("mar")} in a project, or ${colors.cyan('mar run "your task" --yes')} for autonomous mode.\n`);
  return config;
}
