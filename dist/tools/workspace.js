import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DEFAULT_DENY_COMMANDS } from "../config.js";
import { ToolError } from "../errors.js";
import { deniedBy } from "../security/command.js";
import { commandEnvironment, runProcess, shellArgv } from "../security/process.js";
import { hostSandbox } from "../security/sandbox.js";
import { sha256 } from "../util/fs.js";
import { truncateMiddle } from "../util/text.js";
import { FileLedger } from "./ledger.js";
import { applyHunks, parsePatch } from "./patch.js";
const IGNORED = new Set([".git", ".mar", "node_modules", "dist", "build", "coverage", ".next", ".venv", "__pycache__", "target"]);
const MAX_FILE_BYTES = 2_000_000;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
function isInside(root, candidate) {
    const rel = relative(root, candidate);
    return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}
/**
 * The directory an agent works in. All file paths are resolved inside the root,
 * symlinks resolving outside are rejected, and reads open files with O_NOFOLLOW
 * after validation to narrow check-then-use races.
 */
export class Workspace {
    root;
    maxOutput;
    commandTimeoutMs;
    sandbox;
    ledger;
    envPassthrough;
    denyCommands;
    gitRepo;
    constructor(root, options) {
        this.root = root;
        this.maxOutput = options.maxOutput;
        this.commandTimeoutMs = options.commandTimeoutMs;
        this.sandbox = options.sandbox;
        this.envPassthrough = options.envPassthrough;
        this.denyCommands = options.denyCommands;
        this.ledger = options.ledger;
    }
    static async create(path, maxOutputOrOptions = {}, commandTimeoutMs) {
        const options = typeof maxOutputOrOptions === "number"
            ? { maxOutput: maxOutputOrOptions, ...(commandTimeoutMs !== undefined ? { commandTimeoutMs } : {}) }
            : maxOutputOrOptions;
        const root = await realpath(resolve(path));
        const info = await stat(root);
        if (!info.isDirectory())
            throw new ToolError(`Workspace is not a directory: ${root}`);
        return new Workspace(root, {
            maxOutput: options.maxOutput ?? 30_000,
            commandTimeoutMs: options.commandTimeoutMs ?? 120_000,
            sandbox: options.sandbox ?? hostSandbox(),
            envPassthrough: options.envPassthrough ?? [],
            denyCommands: options.denyCommands ?? DEFAULT_DENY_COMMANDS,
            ledger: options.ledger ?? new FileLedger(),
        });
    }
    /** Resolve a workspace-relative path, rejecting lexical and symlink escapes. */
    async resolveSafe(input = ".") {
        if (typeof input !== "string" || input.includes("\0"))
            throw new ToolError("Invalid path.");
        const candidate = resolve(this.root, input);
        if (!isInside(this.root, candidate))
            throw new ToolError(`Path escapes the workspace: ${input}`);
        let ancestor = candidate;
        for (;;) {
            let exists = false;
            try {
                await lstat(ancestor);
                exists = true;
            }
            catch {
                // Walk up until an existing ancestor is found.
            }
            if (exists) {
                let actual;
                try {
                    actual = await realpath(ancestor);
                }
                catch {
                    // Dangling symlink: refuse rather than guess where it points.
                    throw new ToolError(`Path contains a dangling symlink: ${input}`);
                }
                if (!isInside(this.root, actual))
                    throw new ToolError(`Symlink escapes the workspace: ${input}`);
                return ancestor === candidate ? actual : join(actual, relative(ancestor, candidate));
            }
            const parent = dirname(ancestor);
            if (parent === ancestor)
                throw new ToolError(`Cannot resolve path safely: ${input}`);
            ancestor = parent;
        }
    }
    displayPath(path) {
        const rel = relative(this.root, path);
        return rel ? rel.replaceAll(sep, "/") : ".";
    }
    async readValidated(safe, label) {
        const handle = await open(safe, constants.O_RDONLY | O_NOFOLLOW).catch((error) => {
            if (error.code === "ENOENT")
                throw new ToolError(`File not found: ${label}`);
            if (error.code === "ELOOP")
                throw new ToolError(`Refusing to follow a symlink swapped in during the operation: ${label}`);
            if (error.code === "EISDIR")
                throw new ToolError(`Not a file: ${label}`);
            throw error;
        });
        try {
            const info = await handle.stat();
            if (!info.isFile())
                throw new ToolError(`Not a file: ${label}`);
            if (info.size > MAX_FILE_BYTES)
                throw new ToolError(`File is larger than 2 MB: ${label}`);
            return await handle.readFile();
        }
        finally {
            await handle.close();
        }
    }
    /** Current content hash or undefined when the file does not exist. */
    async currentHash(safe) {
        try {
            return sha256(await this.readValidated(safe, this.displayPath(safe)));
        }
        catch (error) {
            if (error instanceof ToolError && /not found/.test(error.message))
                return undefined;
            throw error;
        }
    }
    async read(path, startLine = 1, endLine = 500, agent = "user") {
        const safe = await this.resolveSafe(path);
        const buffer = await this.readValidated(safe, path);
        if (buffer.subarray(0, 8_000).includes(0))
            throw new ToolError(`${path} looks binary (${buffer.length} bytes); not shown.`);
        this.ledger.noteRead(agent, safe, sha256(buffer));
        const text = buffer.toString("utf8");
        const lines = text.split("\n");
        if (text.endsWith("\n"))
            lines.pop();
        const start = Math.max(1, Math.floor(startLine));
        const end = Math.min(lines.length, Math.max(start, Math.floor(endLine)), start + 1999);
        if (!lines.length)
            return `${this.displayPath(safe)} is empty.`;
        if (start > lines.length)
            throw new ToolError(`${path} has only ${lines.length} lines.`);
        const body = lines.slice(start - 1, end)
            .map((line, index) => `${start + index}: ${line.length > 2_000 ? `${line.slice(0, 2_000)}… [line truncated]` : line}`)
            .join("\n");
        const range = start === 1 && end === lines.length ? `${lines.length} lines` : `lines ${start}-${end} of ${lines.length}`;
        return `${this.displayPath(safe)} (${range})\n${body}`;
    }
    async list(path = ".", depth = 4) {
        const safe = await this.resolveSafe(path);
        const baseDepth = safe.split(sep).length;
        const limit = Math.min(Math.max(depth, 0), 8);
        const found = [];
        const walk = async (directory) => {
            if (directory.split(sep).length - baseDepth > limit)
                return;
            const entries = await readdir(directory, { withFileTypes: true });
            for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
                if (IGNORED.has(entry.name))
                    continue;
                if (found.length >= 2000)
                    return;
                const full = join(directory, entry.name);
                found.push(`${this.displayPath(full)}${entry.isDirectory() ? "/" : entry.isSymbolicLink() ? "@" : ""}`);
                if (entry.isDirectory())
                    await walk(full);
            }
        };
        await walk(safe);
        if (found.length >= 2000)
            found.push("[listing truncated at 2000 entries; narrow the path]");
        return found.join("\n") || "(empty directory)";
    }
    /** Files tracked or untracked-but-not-ignored when in Git; a filtered walk otherwise. */
    async files(path = ".", limit = 20_000) {
        const safe = await this.resolveSafe(path);
        if (await this.isGitRepo()) {
            const result = await this.git(["ls-files", "-co", "--exclude-standard", "-z", "--", this.displayPath(safe)], 10 * 1024 * 1024);
            if (result.exitCode === 0) {
                const files = result.stdout.split("\0").filter(Boolean).slice(0, limit);
                return files;
            }
        }
        const files = [];
        const walk = async (directory) => {
            for (const entry of await readdir(directory, { withFileTypes: true })) {
                if (files.length >= limit)
                    return;
                if (IGNORED.has(entry.name) || entry.isSymbolicLink())
                    continue;
                const child = join(directory, entry.name);
                if (entry.isDirectory())
                    await walk(child);
                else if (entry.isFile())
                    files.push(this.displayPath(child));
            }
        };
        const info = await stat(safe);
        if (info.isFile())
            return [this.displayPath(safe)];
        await walk(safe);
        return files.sort();
    }
    async findFiles(pattern, path = ".", limit = 500) {
        const files = (await this.files(path)).filter((file) => matchesGlob(file, pattern));
        if (!files.length)
            return "No files match.";
        const shown = files.slice(0, limit);
        return `${shown.join("\n")}${files.length > limit ? `\n[${files.length - limit} more files not shown]` : ""}`;
    }
    async search(pattern, path = ".", glob, options = {}) {
        const safe = await this.resolveSafe(path);
        const maxResults = Math.min(Math.max(options.maxResults ?? 200, 1), 2_000);
        const args = ["--line-number", "--no-heading", "--color", "never", "--path-separator", "/", "--max-columns", "300", "--max-columns-preview"];
        if (glob)
            args.push("--glob", glob);
        if (options.ignoreCase)
            args.push("--ignore-case");
        if (options.literal)
            args.push("--fixed-strings");
        if (options.context)
            args.push("--context", String(Math.min(options.context, 10)));
        args.push("--", pattern, this.displayPath(safe));
        const result = await runProcess({
            argv: ["rg", ...args], cwd: this.root, env: commandEnvironment([]), timeoutMs: 30_000, maxOutput: this.maxOutput * 2,
        });
        if (result.spawnError)
            return this.searchWithoutRipgrep(pattern, path, glob, options, maxResults);
        if (result.exitCode === 1)
            return "No matches.";
        if (result.exitCode !== 0)
            throw new ToolError(`Search failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
        const lines = result.stdout.split("\n").filter(Boolean);
        const shown = lines.slice(0, maxResults).join("\n");
        return lines.length > maxResults ? `${shown}\n[${lines.length - maxResults} more matching lines not shown; refine the pattern or path]` : shown;
    }
    async searchWithoutRipgrep(pattern, path, glob, options, maxResults) {
        let expression;
        try {
            const source = options.literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern;
            expression = new RegExp(source, options.ignoreCase ? "i" : "");
        }
        catch (error) {
            throw new ToolError(`Invalid search expression: ${error instanceof Error ? error.message : String(error)}`);
        }
        const files = (await this.files(path, 5_000)).filter((file) => !glob || matchesGlob(file, glob));
        const matches = [];
        for (const file of files) {
            let content;
            try {
                const buffer = await readFile(join(this.root, file));
                if (buffer.length > MAX_FILE_BYTES || buffer.subarray(0, 8_000).includes(0))
                    continue;
                content = buffer.toString("utf8");
            }
            catch {
                continue;
            }
            for (const [index, line] of content.split("\n").entries()) {
                if (expression.test(line))
                    matches.push(`${file}:${index + 1}:${line.slice(0, 300)}`);
                if (matches.length >= maxResults)
                    return `${matches.join("\n")}\n[results truncated]`;
            }
        }
        return matches.join("\n") || "No matches.";
    }
    /** Atomically replace a file's content, preserving its mode, inside the workspace. */
    async commit(safe, content) {
        const parent = dirname(safe);
        await mkdir(parent, { recursive: true });
        const actualParent = await realpath(parent);
        if (!isInside(this.root, actualParent))
            throw new ToolError(`Parent directory escapes the workspace: ${this.displayPath(safe)}`);
        const target = join(actualParent, basename(safe));
        let mode;
        try {
            const info = await lstat(target);
            if (info.isSymbolicLink())
                throw new ToolError(`Refusing to replace symlink ${this.displayPath(safe)}; edit its target instead.`);
            if (!info.isFile())
                throw new ToolError(`Not a regular file: ${this.displayPath(safe)}`);
            mode = info.mode & 0o7777;
        }
        catch (error) {
            if (error instanceof ToolError)
                throw error;
        }
        const temporary = join(actualParent, `.${basename(safe)}.mar-${randomUUID().slice(0, 8)}.tmp`);
        const handle = await open(temporary, "wx", mode ?? 0o644);
        try {
            await handle.writeFile(content, "utf8");
        }
        finally {
            await handle.close();
        }
        try {
            if (mode !== undefined)
                await chmod(temporary, mode);
            await rename(temporary, target);
        }
        catch (error) {
            await rm(temporary, { force: true });
            throw error;
        }
    }
    async write(path, content, agent = "user") {
        return (await this.writeFile(path, content, agent)).message;
    }
    async writeFile(path, content, agent = "user") {
        if (Buffer.byteLength(content) > MAX_FILE_BYTES)
            throw new ToolError("Refusing to write a file larger than 2 MB.");
        const safe = await this.resolveSafe(path);
        return this.ledger.locks.run(safe, async () => {
            const current = await this.currentHash(safe);
            const conflict = this.ledger.conflict(agent, safe, this.displayPath(safe), current);
            if (conflict)
                throw new ToolError(conflict);
            await this.commit(safe, content);
            this.ledger.noteWrite(agent, safe, sha256(content));
            const display = this.displayPath(safe);
            return { message: `${current === undefined ? "Created" : "Overwrote"} ${display} (${Buffer.byteLength(content)} bytes).`, modifiedFiles: [display] };
        });
    }
    async replace(path, oldText, newText, all = false, agent = "user") {
        return (await this.edit(path, [{ oldText, newText, all }], agent)).message;
    }
    /** Apply exact-text replacements to one file atomically. Each match must be unique unless `all`. */
    async edit(path, edits, agent = "user") {
        if (!edits.length)
            throw new ToolError("No edits provided.");
        const safe = await this.resolveSafe(path);
        return this.ledger.locks.run(safe, async () => {
            const buffer = await this.readValidated(safe, path);
            const conflict = this.ledger.conflict(agent, safe, this.displayPath(safe), sha256(buffer));
            if (conflict)
                throw new ToolError(conflict);
            let content = buffer.toString("utf8");
            let total = 0;
            for (const [index, edit] of edits.entries()) {
                if (!edit.oldText)
                    throw new ToolError(`Edit ${index + 1}: old_text cannot be empty.`);
                if (edit.oldText === edit.newText)
                    throw new ToolError(`Edit ${index + 1}: old_text and new_text are identical.`);
                const occurrences = content.split(edit.oldText).length - 1;
                if (occurrences === 0) {
                    throw new ToolError(`Edit ${index + 1}: text was not found in ${path}. Re-read the file; whitespace and indentation must match exactly.`);
                }
                if (!edit.all && occurrences !== 1) {
                    throw new ToolError(`Edit ${index + 1}: text occurs ${occurrences} times in ${path}; include more context or set all=true.`);
                }
                content = edit.all ? content.split(edit.oldText).join(edit.newText) : content.replace(edit.oldText, () => edit.newText);
                total += edit.all ? occurrences : 1;
            }
            await this.commit(safe, content);
            this.ledger.noteWrite(agent, safe, sha256(content));
            const display = this.displayPath(safe);
            return { message: `Replaced ${total} occurrence(s) in ${display}.`, modifiedFiles: [display] };
        });
    }
    /** Apply a multi-file unified diff. All files are validated before any is written; failures roll back. */
    async applyPatch(patchText, agent = "user") {
        const patches = parsePatch(patchText);
        const planned = [];
        for (const patch of patches) {
            const sourcePath = patch.oldPath ?? patch.newPath;
            const targetPath = patch.newPath;
            const source = await this.resolveSafe(sourcePath);
            const before = patch.oldPath ? (await this.readValidated(source, sourcePath)).toString("utf8") : undefined;
            if (!patch.oldPath && (await this.currentHash(source)) !== undefined) {
                throw new ToolError(`Patch creates ${sourcePath}, but it already exists.`);
            }
            const applied = applyHunks(before ?? "", patch.hunks, sourcePath);
            if (!targetPath) {
                if (applied.content !== "")
                    throw new ToolError(`Patch deletes ${sourcePath} but does not remove all of its content.`);
                planned.push({ safe: source, display: this.displayPath(source), before, after: undefined, summary: `D ${this.displayPath(source)}` });
                continue;
            }
            const target = await this.resolveSafe(targetPath);
            const counts = `(+${applied.added} -${applied.removed})`;
            if (target !== source) {
                if ((await this.currentHash(target)) !== undefined)
                    throw new ToolError(`Patch renames onto existing file ${targetPath}.`);
                planned.push({ safe: source, display: this.displayPath(source), before, after: undefined, summary: `R ${this.displayPath(source)} → ${this.displayPath(target)}` });
                planned.push({ safe: target, display: this.displayPath(target), before: undefined, after: applied.content, summary: `  ${counts}` });
            }
            else {
                planned.push({ safe: target, display: this.displayPath(target), before, after: applied.content, summary: `${before === undefined ? "A" : "M"} ${this.displayPath(target)} ${counts}` });
            }
        }
        const keys = [...new Set(planned.map((item) => item.safe))].sort();
        const runLocked = async (index) => {
            if (index < keys.length)
                return this.ledger.locks.run(keys[index], () => runLocked(index + 1));
            for (const item of planned) {
                const current = await this.currentHash(item.safe);
                const expected = item.before === undefined ? undefined : sha256(item.before);
                if (current !== expected)
                    throw new ToolError(`${item.display} changed while the patch was being applied; nothing was written.`);
            }
            const done = [];
            try {
                for (const item of planned) {
                    if (item.after === undefined)
                        await rm(item.safe);
                    else
                        await this.commit(item.safe, item.after);
                    done.push(item);
                }
            }
            catch (error) {
                for (const item of done.reverse()) {
                    if (item.before === undefined)
                        await rm(item.safe, { force: true }).catch(() => undefined);
                    else
                        await this.commit(item.safe, item.before).catch(() => undefined);
                }
                throw new ToolError(`Patch failed and was rolled back: ${error instanceof Error ? error.message : String(error)}`);
            }
            for (const item of planned) {
                if (item.after === undefined)
                    this.ledger.noteDelete(agent, item.safe);
                else
                    this.ledger.noteWrite(agent, item.safe, sha256(item.after));
            }
            return {
                message: `Applied patch:\n${planned.map((item) => item.summary).join("\n")}`,
                modifiedFiles: [...new Set(planned.map((item) => item.display))],
            };
        };
        return runLocked(0);
    }
    /** Execute a command through the configured sandbox. Deny rules are checked here as defense in depth. */
    async exec(spec) {
        return this.execStreaming(spec, spec.signal);
    }
    async execStreaming(spec, signal, onOutput) {
        if (!spec.argv?.length && !spec.command?.trim())
            throw new ToolError("Provide argv or command.");
        if (spec.command && spec.command.length > 20_000)
            throw new ToolError("Command is too long.");
        const commandText = spec.argv ? spec.argv.map(quoteArg).join(" ") : spec.command;
        const rule = deniedBy(spec.argv ?? spec.command, this.denyCommands);
        if (rule)
            throw new ToolError(`Command blocked by MAR deny rule "${rule}".`);
        const cwd = spec.cwd ? await this.resolveSafe(spec.cwd) : this.root;
        const argv = spec.argv ?? shellArgv(spec.command);
        const env = commandEnvironment(this.envPassthrough, { MAR_WORKSPACE: this.root });
        const wrapped = this.sandbox.wrap(argv, cwd, env);
        const result = await runProcess({
            argv: wrapped.argv,
            cwd,
            env: wrapped.env,
            timeoutMs: onOutput ? spec.timeoutMs ?? 24 * 60 * 60_000 : Math.min(spec.timeoutMs ?? this.commandTimeoutMs, 60 * 60_000),
            maxOutput: this.maxOutput,
            ...(signal ? { signal } : {}),
            ...(wrapped.onKill ? { onKill: wrapped.onKill } : {}),
            ...(onOutput ? { onOutput: (_stream, chunk) => onOutput(chunk) } : {}),
        });
        return { ...result, commandText };
    }
    /** Backward-compatible string API: resolves with output, rejects on failure. */
    async run(command) {
        const result = await this.exec({ command });
        const output = formatProcessResult(result, this.maxOutput);
        if (result.exitCode !== 0)
            throw new ToolError(`Command failed: ${output}`);
        return output;
    }
    async isGitRepo() {
        if (this.gitRepo === undefined) {
            const result = await this.git(["rev-parse", "--is-inside-work-tree"]);
            this.gitRepo = result.exitCode === 0 && result.stdout.trim() === "true";
        }
        return this.gitRepo;
    }
    /** Run Git directly on the host with a scrubbed environment (read-only operations and MAR's own worktree management). */
    git(args, maxOutput = this.maxOutput * 2, signal) {
        return runProcess({
            argv: ["git", "-c", "core.quotepath=off", "-c", "color.ui=never", ...args],
            cwd: this.root,
            env: commandEnvironment([], { GIT_OPTIONAL_LOCKS: "0" }),
            timeoutMs: 60_000,
            maxOutput,
            ...(signal ? { signal } : {}),
        });
    }
    async status() {
        if (!(await this.isGitRepo()))
            throw new ToolError("The workspace is not a Git repository.");
        const result = await this.git(["status", "--short", "--branch", "--untracked-files=all"]);
        if (result.exitCode !== 0)
            throw new ToolError(`git status failed: ${result.stderr.trim()}`);
        return truncateMiddle(result.stdout.trim() || "Clean working tree.", this.maxOutput);
    }
    async diff(options = {}) {
        if (!(await this.isGitRepo()))
            throw new ToolError("The workspace is not a Git repository.");
        const args = ["diff", "--no-ext-diff", "--no-textconv"];
        if (options.staged)
            args.push("--cached");
        if (options.stat)
            args.push("--stat");
        if (options.base) {
            if (!/^[A-Za-z0-9._/@^~-]{1,200}$/.test(options.base) || options.base.startsWith("-"))
                throw new ToolError("Invalid base revision.");
            args.push(options.base);
        }
        args.push("--");
        if (options.path)
            args.push(this.displayPath(await this.resolveSafe(options.path)));
        const result = await this.git(args);
        if (result.exitCode !== 0)
            throw new ToolError(`git diff failed: ${result.stderr.trim()}`);
        let output = result.stdout;
        if (!options.staged && !options.base) {
            const untracked = await this.git(["ls-files", "--others", "--exclude-standard"]);
            const files = untracked.stdout.split("\n").filter(Boolean);
            if (files.length)
                output += `${output ? "\n" : ""}Untracked files (not shown in diff):\n${files.slice(0, 100).map((file) => `  ${file}`).join("\n")}\n`;
        }
        return truncateMiddle(output.trim() || "No changes.", this.maxOutput);
    }
}
export function formatProcessResult(result, maxOutput) {
    const seconds = (result.durationMs / 1000).toFixed(1);
    let status;
    if (result.spawnError)
        status = `failed to start: ${result.spawnError}`;
    else if (result.timedOut)
        status = `TIMED OUT after ${seconds}s (process tree terminated)`;
    else if (result.cancelled)
        status = `CANCELLED after ${seconds}s (process tree terminated)`;
    else if (result.exitCode === 0)
        status = `exit code 0 (success) in ${seconds}s`;
    else
        status = `exit code ${result.exitCode ?? `signal ${result.signal}`} (FAILED) in ${seconds}s`;
    const parts = [status];
    const stdout = result.stdout.trimEnd();
    const stderr = result.stderr.trimEnd();
    const budget = Math.max(1_000, Math.floor(maxOutput / (stdout && stderr ? 2 : 1)));
    if (stdout)
        parts.push(`--- stdout ---\n${truncateMiddle(stdout, budget)}`);
    if (stderr)
        parts.push(`--- stderr ---\n${truncateMiddle(stderr, budget)}`);
    if (!stdout && !stderr && !result.spawnError)
        parts.push("(no output)");
    return parts.join("\n");
}
function quoteArg(arg) {
    return /^[A-Za-z0-9_./:=@%+-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`;
}
export function matchesGlob(path, glob) {
    const escaped = glob
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replaceAll("**/", "\u0001")
        .replaceAll("**", "\u0000")
        .replaceAll("*", "[^/]*")
        .replaceAll("?", "[^/]")
        .replaceAll("\u0001", "(?:.*/)?")
        .replaceAll("\u0000", ".*");
    const expression = new RegExp(`^${escaped}$`);
    const normalized = path.replaceAll(sep, "/");
    return expression.test(normalized) || (!glob.includes("/") && expression.test(basename(normalized)));
}
//# sourceMappingURL=workspace.js.map