import { exec as execCallback, execFile as execFileCallback } from "node:child_process";
import { lstat, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { ToolError } from "../errors.js";
const exec = promisify(execCallback);
const execFile = promisify(execFileCallback);
const IGNORED = new Set([".git", ".mar", "node_modules", "dist", "build", "coverage", ".next"]);
function isInside(root, candidate) {
    const rel = relative(root, candidate);
    return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}
export class Workspace {
    maxOutput;
    commandTimeoutMs;
    root;
    constructor(root, maxOutput, commandTimeoutMs) {
        this.maxOutput = maxOutput;
        this.commandTimeoutMs = commandTimeoutMs;
        this.root = root;
    }
    static async create(path, maxOutput, commandTimeoutMs) {
        const root = await realpath(resolve(path));
        const info = await stat(root);
        if (!info.isDirectory())
            throw new ToolError(`Workspace is not a directory: ${root}`);
        return new Workspace(root, maxOutput, commandTimeoutMs);
    }
    async resolveSafe(input = ".") {
        const candidate = resolve(this.root, input);
        if (!isInside(this.root, candidate))
            throw new ToolError(`Path escapes the workspace: ${input}`);
        let ancestor = candidate;
        for (;;) {
            try {
                await lstat(ancestor);
                const actual = await realpath(ancestor);
                if (!isInside(this.root, actual))
                    throw new ToolError(`Symlink escapes the workspace: ${input}`);
                return candidate;
            }
            catch (error) {
                if (error instanceof ToolError)
                    throw error;
                const parent = resolve(ancestor, "..");
                if (parent === ancestor)
                    throw new ToolError(`Cannot resolve path safely: ${input}`);
                ancestor = parent;
            }
        }
    }
    displayPath(path) {
        const rel = relative(this.root, path);
        return rel ? rel.replaceAll(sep, "/") : ".";
    }
    async read(path, startLine = 1, endLine = 500) {
        const safe = await this.resolveSafe(path);
        const info = await stat(safe);
        if (!info.isFile())
            throw new ToolError(`Not a file: ${path}`);
        if (info.size > 2_000_000)
            throw new ToolError(`File is larger than 2 MB: ${path}`);
        const lines = (await readFile(safe, "utf8")).split("\n");
        const start = Math.max(1, Math.floor(startLine));
        const end = Math.min(lines.length, Math.max(start, Math.floor(endLine)), start + 1999);
        return lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join("\n");
    }
    async list(path = ".", depth = 4) {
        const safe = await this.resolveSafe(path);
        const baseDepth = safe.split(sep).length;
        const found = [];
        const walk = async (directory) => {
            if (directory.split(sep).length - baseDepth > Math.min(Math.max(depth, 0), 8))
                return;
            const entries = await readdir(directory, { withFileTypes: true });
            for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
                if (IGNORED.has(entry.name))
                    continue;
                const full = join(directory, entry.name);
                found.push(`${this.displayPath(full)}${entry.isDirectory() ? "/" : ""}`);
                if (found.length >= 2000)
                    return;
                if (entry.isDirectory() && !entry.isSymbolicLink())
                    await walk(full);
            }
        };
        await walk(safe);
        return found.join("\n") || "(empty directory)";
    }
    async search(pattern, path = ".", glob) {
        const safe = await this.resolveSafe(path);
        const args = ["--line-number", "--no-heading", "--color", "never", "--path-separator", "/"];
        if (glob)
            args.push("--glob", glob);
        args.push("--", pattern, safe);
        try {
            const { stdout } = await execFile("rg", args, {
                cwd: this.root,
                maxBuffer: this.maxOutput * 2,
                timeout: 30_000,
            });
            return this.trimOutput(stdout.replaceAll(`${this.root}${sep}`, ""));
        }
        catch (error) {
            if (error?.code === 1)
                return "No matches.";
            if (error?.code === "ENOENT")
                return this.searchWithoutRipgrep(pattern, safe, glob);
            throw new ToolError(`Search failed: ${error?.message ?? String(error)}`);
        }
    }
    async searchWithoutRipgrep(pattern, target, glob) {
        let expression;
        try {
            expression = new RegExp(pattern, "g");
        }
        catch (error) {
            throw new ToolError(`Invalid search expression: ${error instanceof Error ? error.message : String(error)}`);
        }
        const files = [];
        const collect = async (path) => {
            const info = await stat(path);
            if (info.isFile()) {
                if (info.size <= 2_000_000 && (!glob || matchesGlob(this.displayPath(path), glob)))
                    files.push(path);
                return;
            }
            for (const entry of await readdir(path, { withFileTypes: true })) {
                if (IGNORED.has(entry.name) || entry.isSymbolicLink())
                    continue;
                const child = join(path, entry.name);
                if (entry.isDirectory())
                    await collect(child);
                else if (entry.isFile()) {
                    const info = await stat(child);
                    if (info.size <= 2_000_000 && (!glob || matchesGlob(this.displayPath(child), glob)))
                        files.push(child);
                }
                if (files.length >= 5000)
                    return;
            }
        };
        await collect(target);
        const matches = [];
        for (const file of files) {
            let content;
            try {
                content = await readFile(file, "utf8");
            }
            catch {
                continue;
            }
            for (const [index, line] of content.split("\n").entries()) {
                expression.lastIndex = 0;
                if (expression.test(line))
                    matches.push(`${this.displayPath(file)}:${index + 1}:${line}`);
                if (matches.length >= 2000)
                    return `${matches.join("\n")}\n[results truncated]`;
            }
        }
        return matches.join("\n") || "No matches.";
    }
    async write(path, content) {
        if (Buffer.byteLength(content) > 2_000_000)
            throw new ToolError("Refusing to write a file larger than 2 MB.");
        const safe = await this.resolveSafe(path);
        await mkdir(resolve(safe, ".."), { recursive: true });
        const temporary = `${safe}.mar-${randomUUID()}.tmp`;
        await writeFile(temporary, content, "utf8");
        await rename(temporary, safe);
        return `Wrote ${Buffer.byteLength(content)} bytes to ${this.displayPath(safe)}.`;
    }
    async replace(path, oldText, newText, all = false) {
        const safe = await this.resolveSafe(path);
        const original = await readFile(safe, "utf8");
        const occurrences = original.split(oldText).length - 1;
        if (!oldText || occurrences === 0)
            throw new ToolError(`Text was not found in ${path}.`);
        if (!all && occurrences !== 1) {
            throw new ToolError(`Text occurs ${occurrences} times in ${path}; provide a unique match or set all=true.`);
        }
        const updated = all ? original.split(oldText).join(newText) : original.replace(oldText, newText);
        await this.write(path, updated);
        return `Replaced ${all ? occurrences : 1} occurrence(s) in ${this.displayPath(safe)}.`;
    }
    async run(command) {
        this.assertCommand(command);
        try {
            const { stdout, stderr } = await exec(command, {
                cwd: this.root,
                timeout: this.commandTimeoutMs,
                maxBuffer: this.maxOutput * 2,
                env: { ...process.env, MAR_WORKSPACE: this.root },
            });
            const output = [stdout, stderr].filter(Boolean).join("\n").trim();
            return this.trimOutput(output || "Command completed successfully (no output).", true);
        }
        catch (error) {
            const output = [error?.stdout, error?.stderr].filter(Boolean).join("\n").trim();
            throw new ToolError(`Command failed${error?.code ? ` (exit ${error.code})` : ""}: ${this.trimOutput(output || error?.message || String(error), true)}`);
        }
    }
    async diff() {
        try {
            const { stdout } = await execFile("git", ["diff", "--no-ext-diff", "--"], {
                cwd: this.root,
                maxBuffer: this.maxOutput * 2,
                timeout: 30_000,
            });
            return this.trimOutput(stdout || "No unstaged changes.");
        }
        catch (error) {
            throw new ToolError(`git diff failed: ${error?.message ?? String(error)}`);
        }
    }
    assertCommand(command) {
        if (!command.trim())
            throw new ToolError("Command cannot be empty.");
        if (command.length > 10_000)
            throw new ToolError("Command is too long.");
        const hardBlocks = [
            /(^|[;&|]\s*)sudo\b/i,
            /(^|[;&|]\s*)rm\s+[^\n]*(?:-[^\n]*r[^\n]*f|-[^\n]*f[^\n]*r)\b/i,
            /(^|[;&|]\s*)(?:mkfs|shutdown|reboot|poweroff)\b/i,
            /\b(?:curl|wget)\b[^\n]*\|\s*(?:sh|bash|zsh)\b/i,
            /(^|\s)\.\.\//,
        ];
        if (hardBlocks.some((pattern) => pattern.test(command))) {
            throw new ToolError("Command blocked by MAR's baseline safety policy.");
        }
    }
    trimOutput(output, keepTail = false) {
        if (output.length <= this.maxOutput)
            return output;
        if (keepTail)
            return `[output truncated]\n${output.slice(-this.maxOutput)}`;
        return `${output.slice(0, this.maxOutput)}\n[output truncated]`;
    }
}
function matchesGlob(path, glob) {
    const escaped = glob
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replaceAll("**", "\u0000")
        .replaceAll("*", "[^/]*")
        .replaceAll("?", "[^/]")
        .replaceAll("\u0000", ".*");
    const expression = new RegExp(`^${escaped}$`);
    return expression.test(path.replaceAll(sep, "/")) || expression.test(basename(path));
}
//# sourceMappingURL=workspace.js.map