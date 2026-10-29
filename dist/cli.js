#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { GLOBAL_CONFIG_PATH, hasConfig, loadConfig, migrateConfigFile } from "./config.js";
import { ConfigurationError, errorMessage } from "./errors.js";
import { ProviderRegistry } from "./providers/registry.js";
import { Orchestrator } from "./runtime/orchestrator.js";
import { Redactor } from "./security/redact.js";
import { probeSandbox } from "./security/sandbox.js";
import { SessionStore, sessionsRoot } from "./session/store.js";
import { runOnboarding } from "./ui/onboarding.js";
import { ApprovalPrompt, banner, colors, createTerminal, Renderer } from "./ui/terminal.js";
import { MAR_VERSION } from "./version.js";
const execFileAsync = promisify(execFile);
const BACKENDS = ["host", "bubblewrap", "docker"];
const APPROVALS = ["on-request", "auto-edit", "never", "read-only"];
function parse(argv) {
    const positional = [];
    const options = { dir: process.cwd(), yes: false, readOnly: false, available: false, verbose: false, verify: false };
    const value = (index, flag) => {
        const next = argv[index];
        if (next === undefined || next.startsWith("--"))
            throw new ConfigurationError(`${flag} requires a value.`);
        return next;
    };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--dir" || arg === "-d")
            options.dir = resolve(value(++index, arg));
        else if (arg === "--config")
            options.config = resolve(value(++index, arg));
        else if (arg === "--yes" || arg === "-y")
            options.yes = true;
        else if (arg === "--read-only")
            options.readOnly = true;
        else if (arg === "--available")
            options.available = true;
        else if (arg === "--verbose" || arg === "-V")
            options.verbose = true;
        else if (arg === "--verify")
            options.verify = true;
        else if (arg === "--sandbox") {
            const backend = value(++index, arg);
            if (!BACKENDS.includes(backend))
                throw new ConfigurationError(`--sandbox must be one of ${BACKENDS.join(", ")}.`);
            options.sandbox = backend;
        }
        else if (arg === "--approval") {
            const mode = value(++index, arg);
            if (!APPROVALS.includes(mode))
                throw new ConfigurationError(`--approval must be one of ${APPROVALS.join(", ")}.`);
            options.approval = mode;
        }
        else if (arg === "--")
            positional.push(...argv.slice(index + 1)), index = argv.length;
        else
            positional.push(arg);
    }
    const known = new Set(["init", "run", "chat", "models", "doctor", "config", "completion", "help", "sessions", "resume"]);
    const first = positional[0];
    if (!first)
        return { command: stdin.isTTY ? "chat" : "help", positional: [], options };
    if (first === "--help" || first === "-h")
        return { command: "help", positional: [], options };
    if (first === "--version" || first === "-v")
        return { command: "version", positional: [], options };
    if (known.has(first))
        return { command: first, positional: positional.slice(1), options };
    return { command: "run", positional, options };
}
function help() {
    return `${banner()} — model-agnostic multi-agent coding

Usage:
  mar                         Start an interactive coding session
  mar init                    Configure the master and worker models
  mar run "task"              Run one task (exit code 0 only if it completed)
  mar "task"                  Shortcut for mar run
  mar sessions                List saved sessions
  mar sessions show <id>      Show a session's journal summary
  mar sessions delete <id>    Delete a saved session
  mar resume [id]             Continue a session (default: latest for this directory)
  mar models [--available]    Show the configured team (and query model catalogs)
  mar doctor                  Validate installation, configuration, and sandboxes
  mar config [path|show|migrate]
                              Locate, print, or upgrade the configuration file
  mar completion <shell>      Print bash, zsh, or fish completion

Options:
  -d, --dir <path>            Workspace (default: current directory)
  --config <path>             Use an explicit config file
  -y, --yes                   Autonomous: allow tool calls without prompts (deny rules still apply)
  --approval <mode>           on-request | auto-edit | never | read-only
  --read-only                 Refuse all writes and commands
  --sandbox <backend>         host | bubblewrap | docker (fails if unavailable; never falls back)
  --verify                    After the run, MAR runs the project checks itself
  -V, --verbose               Show reasoning, tool output previews, retries, and usage
  -h, --help                  Show help
  -v, --version               Show version

Ctrl+C cancels the running task (twice to exit). Commands run on the host unless
a sandbox backend is configured; see SECURITY.md for what each mode protects.`;
}
async function ensureConfiguration(options) {
    if (options.config || await hasConfig())
        return;
    if (!stdin.isTTY)
        throw new ConfigurationError(`No config at ${GLOBAL_CONFIG_PATH}; run "mar init" interactively.`);
    const terminal = createTerminal();
    try {
        await runOnboarding(terminal);
    }
    finally {
        terminal.close();
    }
}
async function loadEffectiveConfig(options) {
    await ensureConfiguration(options);
    const loaded = await loadConfig(options.dir, options.config);
    if (options.sandbox)
        loaded.config.runtime.sandbox.backend = options.sandbox;
    if (options.approval)
        loaded.config.runtime.approval = options.approval;
    return loaded;
}
async function createRuntime(options, terminal, resume) {
    const { config, migrated } = await loadEffectiveConfig(options);
    for (const path of migrated)
        stdout.write(`${colors.yellow("!")} ${path} uses an older format; run "mar config migrate" to upgrade it.\n`);
    const redactor = Redactor.fromEnvironment(process.env, Object.values(config.providers).flatMap((provider) => provider.apiKeyEnv ? [provider.apiKeyEnv] : []));
    const onError = (error) => { stdout.write(`${colors.red("!")} ${error.message}\n`); };
    const session = resume?.session ?? await SessionStore.create(options.dir, { redactor, onError });
    const renderer = new Renderer({ verbose: options.verbose });
    try {
        const runtime = await Orchestrator.create({
            config,
            workspace: options.dir,
            approve: new ApprovalPrompt(terminal).handler,
            onEvent: renderer.handle,
            autoApprove: options.yes,
            readOnly: options.readOnly,
            session,
            redactor,
            ...(resume ? { recovered: resume.recovered } : {}),
        });
        if (!runtime.sandbox.isolated && options.verbose)
            stdout.write(`${colors.gray("Commands run on the host (sandbox: host).")}\n`);
        return { runtime, session, renderer };
    }
    catch (error) {
        await session.close("failed");
        throw error;
    }
}
/** First Ctrl+C cancels the active run; a second one exits. */
function withInterrupt(runtime, terminal, work) {
    let presses = 0;
    const onInterrupt = () => {
        presses += 1;
        if (presses === 1) {
            stdout.write(`\n${colors.yellow("Cancelling… (Ctrl+C again to exit immediately)")}\n`);
            runtime.cancel();
        }
        else {
            process.exit(130);
        }
    };
    process.on("SIGINT", onInterrupt);
    terminal?.on("SIGINT", onInterrupt);
    return work().finally(() => {
        process.off("SIGINT", onInterrupt);
        terminal?.off("SIGINT", onInterrupt);
    });
}
function printReport(report, runtime, verbose) {
    const status = report.status === "completed" ? colors.green(report.status) : colors.yellow(report.status);
    const verdict = report.overall === "confirmed" || report.overall === "tests_passing" ? colors.green(report.overall) : colors.yellow(report.overall);
    stdout.write(`\n${colors.bold("Result:")} ${status} · verification ${verdict}\n`);
    stdout.write(`${colors.gray(report.verification.detail)}\n`);
    if (report.status !== "completed")
        stdout.write(`${report.output}\n`);
    for (const check of report.checks ?? []) {
        stdout.write(`${check.passed ? colors.green("✓") : colors.red("✗")} ${check.name}: ${check.command} (exit ${check.exitCode ?? "none"})\n`);
        if (!check.passed || verbose)
            stdout.write(`${colors.gray(check.output)}\n`);
    }
    const pending = report.tasks.filter((task) => task.status === "completed" && task.isolation === "worktree" || task.status === "conflict");
    for (const task of pending)
        stdout.write(`${colors.yellow("!")} ${task.id} (${task.agent}) ${task.status}: not integrated${task.worktree ? ` — worktree ${task.worktree}` : ""}\n`);
    stdout.write(`${colors.gray(runtime.usage.format())}\n`);
    if (runtime.session)
        stdout.write(`${colors.gray(`session ${runtime.session.metadata.id} · resume with: mar resume ${runtime.session.metadata.id}`)}\n`);
}
async function runOnce(task, options) {
    if (!task.trim())
        throw new ConfigurationError("A task is required. Example: mar run \"add unit tests\"");
    const terminal = stdin.isTTY ? createTerminal() : undefined;
    let runtime;
    try {
        ({ runtime } = await createRuntime(options, terminal));
        const active = runtime;
        const report = await withInterrupt(active, terminal, () => active.runTask(task, { verify: options.verify }));
        printReport(report, active, options.verbose);
        process.exitCode = report.status === "completed" ? (report.overall === "checks_failed" ? 2 : 0) : report.status === "cancelled" ? 130 : 1;
        await active.close(report.status === "completed" ? "completed" : report.status === "cancelled" ? "interrupted" : "failed");
    }
    finally {
        terminal?.close();
    }
}
async function chat(options, resume) {
    const terminal = createTerminal();
    let runtime;
    try {
        ({ runtime } = await createRuntime(options, terminal, resume));
        const active = runtime;
        stdout.write(`\n${banner()}  ${colors.gray(active.workspace.root)}  ${colors.gray(`sandbox: ${active.sandbox.describe()}`)}\n`);
        if (resume) {
            const turns = resume.recovered.messages.filter((message) => message.role === "user").length;
            stdout.write(`${colors.gray(`Resumed session ${resume.session.metadata.id}: ${turns} earlier instruction(s).`)}\n`);
            for (const call of resume.recovered.interruptedCalls) {
                stdout.write(`${colors.yellow("!")} Tool call ${call.name} (${call.id}) ${call.started ? "was interrupted mid-execution; its effects are unknown" : "never started"}. It will not be replayed.\n`);
            }
            if (resume.recovered.corruptRecords)
                stdout.write(`${colors.yellow("!")} ${resume.recovered.corruptRecords} corrupt journal line(s) were skipped.\n`);
        }
        stdout.write(`${colors.gray("/help for commands · Ctrl+C cancels a run · Ctrl+D exits")}\n`);
        for (;;) {
            let input;
            try {
                input = (await terminal.question(`\n${colors.cyan("you ›")} `)).trim();
            }
            catch {
                break;
            }
            if (!input)
                continue;
            if (input === "/exit" || input === "/quit")
                break;
            if (input.startsWith("/")) {
                await slashCommand(input, active, options);
                continue;
            }
            try {
                const report = await withInterrupt(active, terminal, () => active.runTask(input, { verify: options.verify }));
                if (report.status !== "completed" || options.verbose || report.checks)
                    printReport(report, active, options.verbose);
            }
            catch (error) {
                stdout.write(`${colors.red("error:")} ${errorMessage(error)}\n`);
            }
        }
        await active.close("completed");
    }
    catch (error) {
        await runtime?.close("failed");
        throw error;
    }
    finally {
        terminal.close();
    }
}
async function slashCommand(input, runtime, options) {
    const [command] = input.split(/\s+/);
    switch (command) {
        case "/help":
            stdout.write("/agents  /tasks  /diff  /notes  /usage  /context  /compact  /verify  /clear  /exit\n");
            break;
        case "/agents":
            stdout.write(`${runtime.teamStatus()}\n`);
            break;
        case "/tasks":
            stdout.write(`${runtime.tasks.render()}\n`);
            break;
        case "/diff":
            stdout.write(`${await runtime.workspace.diff()}\n`);
            break;
        case "/notes":
            stdout.write(`${runtime.sharedNotes()}\n`);
            break;
        case "/usage":
            stdout.write(`${runtime.usage.format()}\n`);
            break;
        case "/context": {
            const usage = runtime.master.contextUsage();
            stdout.write(`${usage.exact ? "" : "~"}${usage.tokens} tokens of ${usage.usable} usable (window ${usage.window}); compaction at ${usage.threshold}; ${usage.compactions} compaction(s)\n`);
            break;
        }
        case "/compact": {
            const report = await runtime.master.compact();
            stdout.write(report.compacted ? `Compacted ${report.beforeTokens} → ${report.afterTokens} tokens (${report.strategy}).\n` : "Nothing to compact.\n");
            await runtime.persist();
            break;
        }
        case "/verify": {
            const checks = await runtime.verify();
            if (!checks.length)
                stdout.write("No checks configured or detected (set runtime.checks).\n");
            for (const check of checks)
                stdout.write(`${check.passed ? colors.green("✓") : colors.red("✗")} ${check.name}: ${check.command}\n${options.verbose || !check.passed ? `${check.output}\n` : ""}`);
            break;
        }
        case "/clear":
            runtime.reset();
            stdout.write("Conversation context cleared.\n");
            break;
        default: stdout.write(`Unknown command ${command}. /help lists commands.\n`);
    }
}
async function sessions(positional) {
    const [sub, id] = positional;
    if (!sub || sub === "list") {
        const list = await SessionStore.list();
        if (!list.length) {
            stdout.write(`No sessions in ${sessionsRoot()}.\n`);
            return;
        }
        for (const item of list) {
            const status = item.locked ? "running" : item.status;
            stdout.write(`${item.id}  ${status.padEnd(11)}  ${item.updatedAt.slice(0, 19).replace("T", " ")}  ${String(item.turns).padStart(3)} turn(s)  ${item.legacy ? "[0.1 log] " : ""}${item.title || "(untitled)"}\n`);
            stdout.write(`${colors.gray(`    ${item.workspace}`)}\n`);
        }
        return;
    }
    if (sub === "delete" || sub === "rm") {
        if (!id)
            throw new ConfigurationError("Usage: mar sessions delete <id>");
        stdout.write(`Deleted session ${await SessionStore.delete(id)}.\n`);
        return;
    }
    if (sub === "show") {
        if (!id)
            throw new ConfigurationError("Usage: mar sessions show <id>");
        const { meta, records, corrupt, legacy } = await SessionStore.inspect(id);
        stdout.write(`${meta.id}  ${meta.status}  ${meta.workspace}\n${meta.title}\ncreated ${meta.createdAt} · updated ${meta.updatedAt} · ${records.length} journal record(s)${corrupt ? ` · ${corrupt} corrupt` : ""}${legacy ? " · 0.1 log" : ""}\n`);
        const counts = new Map();
        for (const record of records)
            counts.set(record.type, (counts.get(record.type) ?? 0) + 1);
        stdout.write(`${[...counts].map(([type, count]) => `${type}: ${count}`).join(" · ")}\n`);
        return;
    }
    throw new ConfigurationError(`Unknown sessions command "${sub}". Use list, show, or delete.`);
}
async function resumeSession(positional, options) {
    let id = positional[0];
    if (!id) {
        const latest = await SessionStore.latest(options.dir);
        if (!latest)
            throw new ConfigurationError(`No session to resume for ${options.dir}. "mar sessions" lists all sessions.`);
        id = latest.id;
    }
    const { config } = await loadEffectiveConfig(options);
    const redactor = Redactor.fromEnvironment(process.env, Object.values(config.providers).flatMap((provider) => provider.apiKeyEnv ? [provider.apiKeyEnv] : []));
    const session = await SessionStore.open(id, { redactor, onError: (error) => { stdout.write(`${colors.red("!")} ${error.message}\n`); } });
    try {
        const recovered = await session.recover(config.team.master.name);
        options.dir = session.metadata.workspace;
        await chat(options, { session, recovered });
    }
    catch (error) {
        await session.close("interrupted");
        throw error;
    }
}
async function showModels(options) {
    const { config } = await loadEffectiveConfig(options);
    const providers = await ProviderRegistry.create(config);
    const agents = [config.team.master, ...config.team.workers];
    for (const [index, agent] of agents.entries()) {
        const capabilities = providers.capabilities(agent.provider, agent.model, agent.capabilities);
        stdout.write(`${index === 0 ? "master" : "worker"}\t${agent.name}\t${agent.provider}/${agent.model}\t${colors.gray(`context ${capabilities.contextWindow}, output ${capabilities.maxOutputTokens}`)}\n`);
    }
    if (options.available) {
        for (const [id, adapter] of providers.entries()) {
            if (!adapter.listModels) {
                stdout.write(`\n${id}: model discovery is not supported by this adapter\n`);
                continue;
            }
            try {
                stdout.write(`\n${id}:\n${(await adapter.listModels()).map((model) => `  ${model}`).join("\n")}\n`);
            }
            catch (error) {
                stdout.write(`\n${id}: ${colors.red(errorMessage(error))}\n`);
            }
        }
    }
}
async function doctor(options) {
    const checks = [];
    checks.push(["Node.js", Number(process.versions.node.split(".")[0]) >= 20, process.version]);
    try {
        await access(options.dir, constants.R_OK | constants.W_OK);
        checks.push(["Workspace", true, resolve(options.dir)]);
    }
    catch {
        checks.push(["Workspace", false, `not readable/writable: ${options.dir}`]);
    }
    try {
        const { stdout: gitVersion } = await execFileAsync("git", ["--version"]);
        checks.push(["Git", true, gitVersion.trim()]);
    }
    catch {
        checks.push(["Git", "warn", "not found (needed for worktree isolation and git tools)"]);
    }
    try {
        await execFileAsync("rg", ["--version"]);
        checks.push(["ripgrep", true, "available"]);
    }
    catch {
        checks.push(["ripgrep", "warn", "not found (search falls back to a slower built-in scan)"]);
    }
    try {
        await mkdir(sessionsRoot(), { recursive: true, mode: 0o700 });
        await access(sessionsRoot(), constants.W_OK);
        checks.push(["Session store", true, sessionsRoot()]);
    }
    catch (error) {
        checks.push(["Session store", false, `${sessionsRoot()}: ${errorMessage(error)}`]);
    }
    let backend = options.sandbox ?? "host";
    try {
        const { config, paths, migrated } = await loadConfig(options.dir, options.config);
        backend = options.sandbox ?? config.runtime.sandbox.backend;
        checks.push(["Configuration", true, `${paths.join(" + ") || "defaults"}${migrated.length ? ` (older format: ${migrated.join(", ")}; run mar config migrate)` : ""}`]);
        checks.push(["Approval mode", config.runtime.approval === "never" ? "warn" : true, config.runtime.approval]);
        for (const [id, provider] of Object.entries(config.providers)) {
            // Only report whether a key is present, never its value.
            if (provider.apiKeyEnv)
                checks.push([`Key ${id}`, Boolean(process.env[provider.apiKeyEnv]), `${provider.apiKeyEnv} ${process.env[provider.apiKeyEnv] ? "is set" : "is not set"}`]);
            else
                checks.push([`Provider ${id}`, true, provider.baseUrl ?? provider.kind]);
        }
    }
    catch (error) {
        checks.push(["Configuration", false, errorMessage(error)]);
    }
    for (const candidate of BACKENDS.filter((name) => name !== "host")) {
        const probe = await probeSandbox(candidate);
        const selected = candidate === backend;
        checks.push([`Sandbox ${candidate}${selected ? " (selected)" : ""}`, probe.available ? true : selected ? false : "warn", probe.detail]);
    }
    if (backend === "host")
        checks.push(["Sandbox", "warn", "host: commands are NOT isolated (policy and approvals only)"]);
    for (const [name, ok, detail] of checks) {
        const mark = ok === true ? colors.green("✓") : ok === "warn" ? colors.yellow("!") : colors.red("✗");
        stdout.write(`${mark} ${name}: ${detail}\n`);
    }
    if (checks.some(([, ok]) => ok === false))
        process.exitCode = 1;
}
function completion(shell) {
    const commands = "init run chat models doctor config completion sessions resume";
    if (shell === "bash")
        return `complete -W "${commands}" mar`;
    if (shell === "zsh")
        return `#compdef mar\n_arguments '1:command:(${commands})'`;
    if (shell === "fish")
        return commands.split(" ").map((command) => `complete -c mar -f -a ${command}`).join("\n");
    throw new ConfigurationError("Supported shells: bash, zsh, fish");
}
async function main() {
    const { command, positional, options } = parse(process.argv.slice(2));
    switch (command) {
        case "help":
            stdout.write(`${help()}\n`);
            break;
        case "version":
            stdout.write(`${MAR_VERSION}\n`);
            break;
        case "init": {
            const terminal = createTerminal();
            try {
                if (await hasConfig()) {
                    const answer = await terminal.question(`Configuration already exists at ${GLOBAL_CONFIG_PATH}. Replace it? [y/N] `);
                    if (!/^(y|yes|o|oui)$/i.test(answer.trim())) {
                        stdout.write("Configuration unchanged.\n");
                        break;
                    }
                }
                await runOnboarding(terminal);
            }
            finally {
                terminal.close();
            }
            break;
        }
        case "run":
            await runOnce(positional.join(" "), options);
            break;
        case "chat":
            await chat(options);
            break;
        case "sessions":
            await sessions(positional);
            break;
        case "resume":
            await resumeSession(positional, options);
            break;
        case "models":
            await showModels(options);
            break;
        case "doctor":
            await doctor(options);
            break;
        case "config": {
            if (positional[0] === "show") {
                const loaded = await loadConfig(options.dir, options.config);
                // Header values may carry credentials; show only their names.
                const shown = structuredClone(loaded.config);
                for (const provider of Object.values(shown.providers)) {
                    if (provider.headers)
                        provider.headers = Object.fromEntries(Object.keys(provider.headers).map((name) => [name, "[hidden]"]));
                }
                stdout.write(`${JSON.stringify(shown, null, 2)}\n`);
            }
            else if (positional[0] === "migrate") {
                const path = options.config ?? GLOBAL_CONFIG_PATH;
                const result = await migrateConfigFile(path);
                stdout.write(result.from === undefined ? `${path} is already version 2.\n` : `Migrated ${path} from version ${result.from} to 2 (backup: ${result.backup}).\n`);
            }
            else
                stdout.write(`${GLOBAL_CONFIG_PATH}\n`);
            break;
        }
        case "completion":
            stdout.write(`${completion(positional[0] ?? "")}\n`);
            break;
        default: throw new ConfigurationError(`Unknown command: ${command}`);
    }
}
main().catch((error) => {
    stdout.write(`${colors.red("MAR error:")} ${errorMessage(error)}\n`);
    process.exitCode = 1;
});
//# sourceMappingURL=cli.js.map