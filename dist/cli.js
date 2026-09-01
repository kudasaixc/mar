#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { GLOBAL_CONFIG_PATH, hasConfig, loadConfig } from "./config.js";
import { ConfigurationError } from "./errors.js";
import { ProviderRegistry } from "./providers/registry.js";
import { Orchestrator } from "./runtime/orchestrator.js";
import { SessionStore } from "./runtime/session.js";
import { runOnboarding } from "./ui/onboarding.js";
import { ApprovalPrompt, banner, colors, createTerminal, printEvent } from "./ui/terminal.js";
const VERSION = "0.1.0";
const execFileAsync = promisify(execFile);
function parse(argv) {
    const positional = [];
    const options = { dir: process.cwd(), yes: false, readOnly: false, available: false };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--dir" || arg === "-d")
            options.dir = resolve(argv[++index] ?? "");
        else if (arg === "--config")
            options.config = resolve(argv[++index] ?? "");
        else if (arg === "--yes" || arg === "-y")
            options.yes = true;
        else if (arg === "--read-only")
            options.readOnly = true;
        else if (arg === "--available")
            options.available = true;
        else
            positional.push(arg);
    }
    const known = new Set(["init", "run", "chat", "models", "doctor", "config", "completion", "help"]);
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
  mar run "task"              Run one task
  mar "task"                  Shortcut for mar run
  mar models [--available]    Show the configured team (and query model catalogs)
  mar doctor                  Validate the installation and configuration
  mar config [path|show]      Locate or print the merged configuration
  mar completion <shell>      Print bash, zsh, or fish completion

Options:
  -d, --dir <path>            Shared workspace (default: current directory)
  --config <path>             Use an explicit config file
  -y, --yes                   Allow mutating tool calls without prompts
  --read-only                 Disable all mutating tool calls
  -h, --help                  Show help
  -v, --version               Show version

Security: --yes grants models permission to edit files and run commands in the
workspace. MAR still blocks a small baseline of destructive command patterns.`;
}
async function ensureConfiguration() {
    if (await hasConfig())
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
async function createRuntime(options, terminal = createTerminal()) {
    await ensureConfiguration();
    const { config, paths } = await loadConfig(options.dir, options.config);
    const session = await SessionStore.create(options.dir);
    const approvals = new ApprovalPrompt(terminal);
    const onEvent = (event) => {
        printEvent(event);
        void session.append("runtime:event", event);
    };
    const runtime = await Orchestrator.create({
        config,
        workspace: options.dir,
        approve: approvals.handler,
        onEvent,
        autoApprove: options.yes,
        readOnly: options.readOnly,
    });
    return { runtime, session, paths, terminal };
}
async function runOnce(task, options) {
    if (!task.trim())
        throw new Error("A task is required. Example: mar run \"add unit tests\"");
    const terminal = createTerminal();
    try {
        const { runtime, session } = await createRuntime(options, terminal);
        await session.append("user:task", { task });
        const result = await runtime.run(task);
        await session.append("assistant:result", { result });
    }
    finally {
        terminal.close();
    }
}
async function chat(options) {
    const terminal = createTerminal();
    try {
        const { runtime, session } = await createRuntime(options, terminal);
        stdout.write(`\n${banner()}  ${colors.gray(runtime.workspace.root)}\n`);
        stdout.write(`${colors.gray("/help for commands · Ctrl-D to exit")}\n`);
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
            if (input === "/help") {
                stdout.write("/agents  /diff  /notes  /clear  /exit\n");
                continue;
            }
            if (input === "/agents") {
                stdout.write(`${runtime.teamStatus()}\n`);
                continue;
            }
            if (input === "/diff") {
                stdout.write(`${await runtime.workspace.diff()}\n`);
                continue;
            }
            if (input === "/notes") {
                stdout.write(`${runtime.sharedNotes()}\n`);
                continue;
            }
            if (input === "/clear") {
                runtime.reset();
                stdout.write("Conversation context cleared.\n");
                continue;
            }
            await session.append("user:task", { task: input });
            try {
                const result = await runtime.run(input);
                await session.append("assistant:result", { result });
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                stdout.write(`${colors.red("error:")} ${message}\n`);
                await session.append("runtime:error", { message });
            }
        }
    }
    finally {
        terminal.close();
    }
}
async function showModels(options) {
    await ensureConfiguration();
    const { config } = await loadConfig(options.dir, options.config);
    const agents = [config.team.master, ...config.team.workers];
    for (const [index, agent] of agents.entries()) {
        stdout.write(`${index === 0 ? "master" : "worker"}\t${agent.name}\t${agent.provider}/${agent.model}\n`);
    }
    if (options.available) {
        const providers = await ProviderRegistry.create(config);
        for (const [id, adapter] of providers.entries()) {
            if (!adapter.listModels) {
                stdout.write(`\n${id}: model discovery is not supported by this adapter\n`);
                continue;
            }
            try {
                stdout.write(`\n${id}:\n${(await adapter.listModels()).map((model) => `  ${model}`).join("\n")}\n`);
            }
            catch (error) {
                stdout.write(`\n${id}: ${colors.red(error instanceof Error ? error.message : String(error))}\n`);
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
        checks.push(["Git", false, "not found (optional, but recommended)"]);
    }
    try {
        const { config, paths } = await loadConfig(options.dir, options.config);
        checks.push(["Configuration", true, paths.join(" + ")]);
        for (const [id, provider] of Object.entries(config.providers)) {
            if (provider.apiKeyEnv)
                checks.push([`Key ${id}`, Boolean(process.env[provider.apiKeyEnv]), provider.apiKeyEnv]);
            else
                checks.push([`Provider ${id}`, true, provider.baseUrl ?? provider.kind]);
        }
    }
    catch (error) {
        checks.push(["Configuration", false, error instanceof Error ? error.message : String(error)]);
    }
    for (const [name, ok, detail] of checks)
        stdout.write(`${ok ? colors.green("✓") : colors.red("✗")} ${name}: ${detail}\n`);
    if (checks.some(([, ok]) => !ok))
        process.exitCode = 1;
}
function completion(shell) {
    const commands = "init run chat models doctor config completion";
    if (shell === "bash")
        return `complete -W "${commands}" mar`;
    if (shell === "zsh")
        return `#compdef mar\n_arguments '1:command:(${commands.replaceAll(" ", " ")})'`;
    if (shell === "fish")
        return commands.split(" ").map((command) => `complete -c mar -f -a ${command}`).join("\n");
    throw new Error("Supported shells: bash, zsh, fish");
}
async function main() {
    const { command, positional, options } = parse(process.argv.slice(2));
    switch (command) {
        case "help":
            stdout.write(`${help()}\n`);
            break;
        case "version":
            stdout.write(`${VERSION}\n`);
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
        case "models":
            await showModels(options);
            break;
        case "doctor":
            await doctor(options);
            break;
        case "config": {
            if (positional[0] === "show") {
                const loaded = await loadConfig(options.dir, options.config);
                stdout.write(`${JSON.stringify(loaded.config, null, 2)}\n`);
            }
            else
                stdout.write(`${GLOBAL_CONFIG_PATH}\n`);
            break;
        }
        case "completion":
            stdout.write(`${completion(positional[0] ?? "")}\n`);
            break;
        default: throw new Error(`Unknown command: ${command}`);
    }
}
main().catch((error) => {
    stdout.write(`${colors.red("MAR error:")} ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
});
//# sourceMappingURL=cli.js.map