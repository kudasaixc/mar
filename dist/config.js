import { access, copyFile, mkdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ConfigurationError } from "./errors.js";
import { isRecord, writeFileAtomic } from "./util/fs.js";
const CONFIG_DIR = process.env.MAR_CONFIG_DIR
    ? resolve(process.env.MAR_CONFIG_DIR)
    : join(homedir(), ".config", "mar");
export const GLOBAL_CONFIG_PATH = join(CONFIG_DIR, "config.json");
export const CONFIG_VERSION = 2;
/** Safe read-only commands that never need a prompt outside read-only mode. */
export const DEFAULT_ALLOW_COMMANDS = [
    "git status", "git diff", "git log", "git show", "git rev-parse", "git ls-files",
    "ls", "pwd", "cat", "head", "tail", "wc", "rg", "grep", "which",
];
export const DEFAULT_DENY_COMMANDS = [
    "sudo", "su", "doas", "rm -rf", "rm --recursive --force", "mkfs", "dd", "chmod -R 777", "shutdown", "reboot", "poweroff", "halt",
    "git push --force", "git push -f", "git reset --hard", "git clean -fdx", "git clean -fd",
];
export function defaultRuntime() {
    return {
        approval: "on-request",
        commandTimeoutMs: 120_000,
        maxToolOutput: 30_000,
        plugins: [],
        sandbox: { backend: "host", network: false, image: "node:22-bookworm", readOnlyPaths: [] },
        allowCommands: [...DEFAULT_ALLOW_COMMANDS],
        denyCommands: [...DEFAULT_DENY_COMMANDS],
        envPassthrough: [],
        checks: {},
        stream: true,
        context: {
            compactAt: 0.8,
            targetAfterCompaction: 0.5,
            keepRecentTurns: 4,
            maxToolResultChars: 2_000,
            summarizer: "model",
        },
        concurrency: { maxWorkers: 4, isolation: "auto", workerTimeoutMs: 30 * 60_000, maxDelegations: 32 },
        budgets: {},
        retry: { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 30_000 },
    };
}
export function defaultConfig() {
    return {
        version: CONFIG_VERSION,
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
        runtime: defaultRuntime(),
        pricing: {},
    };
}
async function exists(path) {
    try {
        await access(path, constants.R_OK);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Upgrade older configuration documents in memory. Version 1 files remain valid:
 * every new field receives its default. The file on disk is only rewritten by
 * `mar config migrate`.
 */
export function migrateConfig(value) {
    if (!isRecord(value))
        throw new ConfigurationError("Configuration must be a JSON object.");
    if (value.version === CONFIG_VERSION)
        return { config: value };
    if (value.version === 1) {
        const runtime = isRecord(value.runtime) ? value.runtime : {};
        return {
            config: { ...value, version: CONFIG_VERSION, runtime: { ...runtime }, pricing: isRecord(value.pricing) ? value.pricing : {} },
            migratedFrom: 1,
        };
    }
    throw new ConfigurationError(`Unsupported MAR config version ${String(value.version)} (expected 1 or ${CONFIG_VERSION}).`);
}
function validateProvider(id, value) {
    if (!isRecord(value))
        throw new ConfigurationError(`Provider "${id}" must be an object.`);
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
    if (value.headers !== undefined && !isRecord(value.headers)) {
        throw new ConfigurationError(`Provider "${id}" headers must be an object.`);
    }
    if (value.timeoutMs !== undefined && !(typeof value.timeoutMs === "number" && value.timeoutMs > 0)) {
        throw new ConfigurationError(`Provider "${id}" timeoutMs must be a positive number.`);
    }
}
function validateAgent(value, label, providers) {
    if (!isRecord(value))
        throw new ConfigurationError(`${label} must be an object.`);
    for (const field of ["name", "description", "provider", "model"]) {
        if (typeof value[field] !== "string" || value[field].trim() === "") {
            throw new ConfigurationError(`${label}.${field} must be a non-empty string.`);
        }
    }
    if (!providers[value.provider]) {
        throw new ConfigurationError(`${label} references unknown provider "${String(value.provider)}".`);
    }
    if (value.fallbacks !== undefined) {
        if (!Array.isArray(value.fallbacks))
            throw new ConfigurationError(`${label}.fallbacks must be an array.`);
        value.fallbacks.forEach((fallback, index) => {
            if (!isRecord(fallback) || typeof fallback.provider !== "string" || typeof fallback.model !== "string") {
                throw new ConfigurationError(`${label}.fallbacks[${index}] must contain provider and model strings.`);
            }
            if (!providers[fallback.provider]) {
                throw new ConfigurationError(`${label}.fallbacks[${index}] references unknown provider "${fallback.provider}".`);
            }
        });
    }
    if (value.maxTurns !== undefined && !(Number.isInteger(value.maxTurns) && value.maxTurns > 0)) {
        throw new ConfigurationError(`${label}.maxTurns must be a positive integer.`);
    }
    if (value.compactAt !== undefined && !fraction(value.compactAt)) {
        throw new ConfigurationError(`${label}.compactAt must be between 0 and 1.`);
    }
}
const fraction = (value) => typeof value === "number" && value > 0 && value < 1;
const positive = (value) => typeof value === "number" && Number.isFinite(value) && value > 0;
function stringList(value, label, fallback) {
    if (value === undefined)
        return fallback;
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        throw new ConfigurationError(`${label} must be an array of strings.`);
    }
    return value;
}
function normalizeRuntime(value) {
    if (!isRecord(value))
        throw new ConfigurationError("runtime settings are required.");
    const defaults = defaultRuntime();
    if (!["on-request", "auto-edit", "never", "read-only"].includes(String(value.approval))) {
        throw new ConfigurationError("runtime.approval must be on-request, auto-edit, never, or read-only.");
    }
    const sandbox = isRecord(value.sandbox) ? value.sandbox : {};
    const backend = (sandbox.backend ?? defaults.sandbox.backend);
    if (!["host", "bubblewrap", "docker"].includes(backend)) {
        throw new ConfigurationError("runtime.sandbox.backend must be host, bubblewrap, or docker.");
    }
    const context = { ...defaults.context, ...(isRecord(value.context) ? value.context : {}) };
    if (!fraction(context.compactAt) || !fraction(context.targetAfterCompaction) || context.targetAfterCompaction >= context.compactAt) {
        throw new ConfigurationError("runtime.context.compactAt and targetAfterCompaction must be fractions with target < compactAt.");
    }
    if (!["model", "deterministic"].includes(context.summarizer)) {
        throw new ConfigurationError("runtime.context.summarizer must be model or deterministic.");
    }
    const concurrency = { ...defaults.concurrency, ...(isRecord(value.concurrency) ? value.concurrency : {}) };
    if (!Number.isInteger(concurrency.maxWorkers) || concurrency.maxWorkers < 1 || concurrency.maxWorkers > 32) {
        throw new ConfigurationError("runtime.concurrency.maxWorkers must be an integer from 1 to 32.");
    }
    if (!["auto", "worktree", "shared"].includes(concurrency.isolation)) {
        throw new ConfigurationError("runtime.concurrency.isolation must be auto, worktree, or shared.");
    }
    const budgets = isRecord(value.budgets) ? value.budgets : {};
    for (const key of ["maxCostUsd", "maxTokens", "maxRuntimeMs"]) {
        if (budgets[key] !== undefined && !positive(budgets[key]))
            throw new ConfigurationError(`runtime.budgets.${key} must be positive.`);
    }
    const retry = { ...defaults.retry, ...(isRecord(value.retry) ? value.retry : {}) };
    if (!Number.isInteger(retry.maxAttempts) || retry.maxAttempts < 1 || retry.maxAttempts > 10) {
        throw new ConfigurationError("runtime.retry.maxAttempts must be an integer from 1 to 10.");
    }
    const checks = value.checks === undefined ? {} : value.checks;
    if (!isRecord(checks) || Object.values(checks).some((command) => typeof command !== "string" || !command.trim())) {
        throw new ConfigurationError("runtime.checks must map names to command strings.");
    }
    return {
        approval: value.approval,
        commandTimeoutMs: positive(value.commandTimeoutMs) ? value.commandTimeoutMs : defaults.commandTimeoutMs,
        maxToolOutput: positive(value.maxToolOutput) ? value.maxToolOutput : defaults.maxToolOutput,
        plugins: stringList(value.plugins, "runtime.plugins", []),
        sandbox: {
            backend,
            network: typeof sandbox.network === "boolean" ? sandbox.network : defaults.sandbox.network,
            image: typeof sandbox.image === "string" && sandbox.image ? sandbox.image : defaults.sandbox.image,
            readOnlyPaths: stringList(sandbox.readOnlyPaths, "runtime.sandbox.readOnlyPaths", []),
        },
        allowCommands: stringList(value.allowCommands, "runtime.allowCommands", defaults.allowCommands),
        denyCommands: stringList(value.denyCommands, "runtime.denyCommands", defaults.denyCommands),
        envPassthrough: stringList(value.envPassthrough, "runtime.envPassthrough", []),
        checks: checks,
        stream: typeof value.stream === "boolean" ? value.stream : defaults.stream,
        context,
        concurrency,
        budgets: budgets,
        retry,
    };
}
export function validateConfig(input) {
    const { config: value } = migrateConfig(input);
    if (!isRecord(value.providers) || Object.keys(value.providers).length === 0) {
        throw new ConfigurationError("At least one provider is required.");
    }
    for (const [id, provider] of Object.entries(value.providers))
        validateProvider(id, provider);
    if (!isRecord(value.team) || !Array.isArray(value.team.workers)) {
        throw new ConfigurationError("team.master and team.workers are required.");
    }
    const providers = value.providers;
    validateAgent(value.team.master, "team.master", providers);
    const names = new Set([value.team.master.name]);
    value.team.workers.forEach((worker, index) => {
        validateAgent(worker, `team.workers[${index}]`, providers);
        if (names.has(worker.name))
            throw new ConfigurationError(`Agent name "${worker.name}" is duplicated.`);
        names.add(worker.name);
    });
    const pricing = value.pricing === undefined ? {} : value.pricing;
    if (!isRecord(pricing))
        throw new ConfigurationError("pricing must be an object.");
    for (const [key, price] of Object.entries(pricing)) {
        if (!isRecord(price) || typeof price.input !== "number" || typeof price.output !== "number") {
            throw new ConfigurationError(`pricing["${key}"] requires numeric input and output prices (USD per million tokens).`);
        }
    }
    return {
        version: CONFIG_VERSION,
        providers,
        team: value.team,
        runtime: normalizeRuntime(value.runtime),
        pricing: pricing,
    };
}
async function readJson(path) {
    try {
        return JSON.parse(await readFile(path, "utf8"));
    }
    catch (error) {
        if (error instanceof SyntaxError)
            throw new ConfigurationError(`Invalid JSON in ${path}: ${error.message}`);
        throw error;
    }
}
function mergeConfig(base, project) {
    const runtime = isRecord(project.runtime) ? project.runtime : {};
    return {
        ...base,
        ...project,
        version: CONFIG_VERSION,
        providers: { ...base.providers, ...(isRecord(project.providers) ? project.providers : {}) },
        team: { ...base.team, ...(isRecord(project.team) ? project.team : {}) },
        runtime: {
            ...base.runtime,
            ...runtime,
            sandbox: { ...base.runtime.sandbox, ...(isRecord(runtime.sandbox) ? runtime.sandbox : {}) },
            context: { ...base.runtime.context, ...(isRecord(runtime.context) ? runtime.context : {}) },
            concurrency: { ...base.runtime.concurrency, ...(isRecord(runtime.concurrency) ? runtime.concurrency : {}) },
            budgets: { ...base.runtime.budgets, ...(isRecord(runtime.budgets) ? runtime.budgets : {}) },
            retry: { ...base.runtime.retry, ...(isRecord(runtime.retry) ? runtime.retry : {}) },
            checks: { ...base.runtime.checks, ...(isRecord(runtime.checks) ? runtime.checks : {}) },
        },
        pricing: { ...base.pricing, ...(isRecord(project.pricing) ? project.pricing : {}) },
    };
}
export async function findProjectConfig(workspace) {
    let current = resolve(workspace);
    for (;;) {
        const candidate = join(current, "mar.config.json");
        if (await exists(candidate))
            return candidate;
        const parent = dirname(current);
        if (parent === current)
            return undefined;
        current = parent;
    }
}
export async function loadConfig(workspace = process.cwd(), explicitPath) {
    const globalPath = explicitPath ? resolve(explicitPath) : GLOBAL_CONFIG_PATH;
    if (!(await exists(globalPath))) {
        throw new ConfigurationError(`No configuration found at ${globalPath}. Run "mar init" first.`);
    }
    const globalRaw = await readJson(globalPath);
    const migrated = [];
    if (migrateConfig(globalRaw).migratedFrom !== undefined)
        migrated.push(globalPath);
    let config = validateConfig(globalRaw);
    const paths = [globalPath];
    if (!explicitPath) {
        const projectPath = await findProjectConfig(workspace);
        if (projectPath && projectPath !== globalPath) {
            const projectRaw = await readJson(projectPath);
            if (!isRecord(projectRaw))
                throw new ConfigurationError(`${projectPath} must contain a JSON object.`);
            if (projectRaw.version !== undefined && projectRaw.version !== CONFIG_VERSION)
                migrated.push(projectPath);
            config = validateConfig(mergeConfig(config, projectRaw));
            paths.push(projectPath);
        }
    }
    return { config, paths, migrated };
}
export async function saveConfig(config, path = GLOBAL_CONFIG_PATH) {
    const normalized = validateConfig(config);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFileAtomic(path, `${JSON.stringify(normalized, null, 2)}\n`, 0o600);
}
/** Rewrite a configuration file in the current schema, keeping a `.bak` copy. */
export async function migrateConfigFile(path = GLOBAL_CONFIG_PATH) {
    const raw = await readJson(path);
    const { migratedFrom } = migrateConfig(raw);
    if (migratedFrom === undefined)
        return {};
    const backup = `${path}.v${migratedFrom}.bak`;
    await copyFile(path, backup);
    await saveConfig(validateConfig(raw), path);
    return { from: migratedFrom, backup };
}
export async function hasConfig() {
    return exists(GLOBAL_CONFIG_PATH);
}
//# sourceMappingURL=config.js.map