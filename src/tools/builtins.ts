import { DEFAULT_ALLOW_COMMANDS } from "../config.js";
import { allowedBy } from "../security/command.js";
import { looksLikeCheck, type PlanStep, type TaskState } from "../context/task-state.js";
import { ToolError } from "../errors.js";
import type { MemoryKind, MemoryScope, MemoryStore } from "../memory/store.js";
import { booleanArg, numberArg, stringArg, stringArrayArg, type ToolRegistry } from "./registry.js";
import type { ProcessManager } from "./processes.js";
import type { ToolDefinition, ToolResult } from "./types.js";
import { formatProcessResult, type Workspace } from "./workspace.js";

const objectSchema = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

export interface BuiltinContext {
  workspace: Workspace;
  memory: MemoryStore;
  /** The calling agent's task state (plan/decisions). */
  taskState: TaskState;
  processes: ProcessManager;
  /** Named verification commands available to run_check. */
  checks: Record<string, string>;
}

function execSpec(args: Record<string, unknown>): { argv?: string[]; command?: string } {
  const argv = stringArrayArg(args, "argv");
  const command = stringArg(args, "command", false);
  if (argv?.length && command) throw new ToolError("Provide either argv or command, not both.");
  if (argv?.length) return { argv };
  if (command) return { command };
  throw new ToolError("Provide argv (preferred, no shell) or command (shell string).");
}

export function builtinTools(context: BuiltinContext): ToolDefinition[] {
  const { workspace, memory, taskState, processes } = context;
  const checkNames = Object.keys(context.checks);
  const runCommand = async (spec: { argv?: string[]; command?: string; cwd?: string; timeoutMs?: number }, signal: AbortSignal | undefined, checkName?: string): Promise<ToolResult> => {
    const result = await workspace.exec({ ...spec, ...(signal ? { signal } : {}) });
    const passed = result.exitCode === 0 && !result.timedOut && !result.cancelled && !result.spawnError;
    const isCheck = checkName !== undefined || looksLikeCheck(result.commandText);
    return {
      ok: passed,
      output: formatProcessResult(result, workspace.maxOutput),
      meta: {
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        cancelled: result.cancelled,
        truncated: result.truncated,
        ...(!isCheck && allowedBy(spec.argv ?? spec.command ?? "", DEFAULT_ALLOW_COMMANDS) ? { noChanges: true } : {}),
        ...(isCheck ? { check: { name: checkName ?? "command", command: result.commandText, passed, exitCode: result.exitCode } } : {}),
      },
    };
  };

  return [
    {
      spec: {
        name: "list_files",
        description: "List files and directories (directories end with /, symlinks with @). Skips .git, node_modules and build output.",
        parameters: objectSchema({
          path: { type: "string", description: "Workspace-relative directory (default: .)" },
          depth: { type: "number", description: "Maximum traversal depth, up to 8 (default 4)" },
        }),
      },
      mutating: false,
      permission: "read",
      execute: async (args) => ({ ok: true, output: await workspace.list(stringArg(args, "path", false) || ".", numberArg(args, "depth", 4)) }),
    },
    {
      spec: {
        name: "find_files",
        description: "Find files by glob (e.g. **/*.test.ts). Respects .gitignore in Git repositories.",
        parameters: objectSchema({
          pattern: { type: "string", description: "Glob; ** matches any directories" },
          path: { type: "string", description: "Directory to search (default: .)" },
        }, ["pattern"]),
      },
      mutating: false,
      permission: "read",
      execute: async (args) => ({ ok: true, output: await workspace.findFiles(stringArg(args, "pattern"), stringArg(args, "path", false) || ".") }),
    },
    {
      spec: {
        name: "read_file",
        description: "Read a UTF-8 text file with line numbers. Use start_line/end_line for large files (max 2000 lines per call).",
        parameters: objectSchema({
          path: { type: "string" },
          start_line: { type: "number" },
          end_line: { type: "number" },
        }, ["path"]),
      },
      mutating: false,
      permission: "read",
      execute: async (args, ctx) => ({
        ok: true,
        output: await workspace.read(stringArg(args, "path"), numberArg(args, "start_line", 1), numberArg(args, "end_line", 500), ctx.agent),
      }),
    },
    {
      spec: {
        name: "search",
        description: "Search file contents with a regular expression (ripgrep when installed; respects .gitignore). Returns path:line:text.",
        parameters: objectSchema({
          pattern: { type: "string" },
          path: { type: "string", description: "File or directory (default: .)" },
          glob: { type: "string", description: "Optional file glob, e.g. *.ts" },
          ignore_case: { type: "boolean" },
          literal: { type: "boolean", description: "Treat pattern as plain text" },
          context: { type: "number", description: "Lines of context around matches (max 10)" },
          max_results: { type: "number", description: "Maximum matching lines (default 200)" },
        }, ["pattern"]),
      },
      mutating: false,
      permission: "read",
      execute: async (args) => ({
        ok: true,
        output: await workspace.search(stringArg(args, "pattern"), stringArg(args, "path", false) || ".", stringArg(args, "glob", false) || undefined, {
          ignoreCase: booleanArg(args, "ignore_case"),
          literal: booleanArg(args, "literal"),
          context: numberArg(args, "context", 0),
          maxResults: numberArg(args, "max_results", 200),
        }),
      }),
    },
    {
      spec: {
        name: "write_file",
        description: "Create a new file, or fully overwrite a file you have read. Prefer edit_file/apply_patch for changes to existing files.",
        parameters: objectSchema({ path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
      },
      mutating: true,
      permission: "write",
      summarize: (args) => `write ${String(args.path)} (${typeof args.content === "string" ? args.content.length : 0} chars)`,
      execute: async (args, ctx) => {
        const result = await workspace.writeFile(stringArg(args, "path"), stringArg(args, "content"), ctx.agent);
        return { ok: true, output: result.message, meta: { modifiedFiles: result.modifiedFiles } };
      },
    },
    {
      spec: {
        name: "edit_file",
        description: "Replace exact text in one file. Either old_text/new_text, or edits=[{old_text,new_text,all}] applied in order atomically. Each old_text must match exactly once unless all=true.",
        parameters: objectSchema({
          path: { type: "string" },
          old_text: { type: "string" },
          new_text: { type: "string" },
          all: { type: "boolean" },
          edits: {
            type: "array",
            items: objectSchema({ old_text: { type: "string" }, new_text: { type: "string" }, all: { type: "boolean" } }, ["old_text", "new_text"]),
          },
        }, ["path"]),
      },
      mutating: true,
      permission: "write",
      summarize: (args) => `edit ${String(args.path)}${Array.isArray(args.edits) ? ` (${args.edits.length} edits)` : ""}`,
      execute: async (args, ctx) => {
        const list = Array.isArray(args.edits) ? args.edits as Array<Record<string, unknown>> : undefined;
        const edits = list
          ? list.map((edit) => ({ oldText: stringArg(edit, "old_text"), newText: stringArg(edit, "new_text"), all: edit.all === true }))
          : [{ oldText: stringArg(args, "old_text"), newText: stringArg(args, "new_text"), all: args.all === true }];
        const result = await workspace.edit(stringArg(args, "path"), edits, ctx.agent);
        return { ok: true, output: result.message, meta: { modifiedFiles: result.modifiedFiles } };
      },
    },
    {
      spec: {
        name: "apply_patch",
        description: "Apply a unified diff (one or more files: --- a/path, +++ b/path, @@ hunks). Supports create (--- /dev/null), delete (+++ /dev/null) and rename. All-or-nothing: if any hunk fails nothing is written.",
        parameters: objectSchema({ patch: { type: "string" } }, ["patch"]),
      },
      mutating: true,
      permission: "write",
      summarize: (args) => {
        const patch = typeof args.patch === "string" ? args.patch : "";
        const files = [...patch.matchAll(/^\+\+\+ (?:b\/)?(.+)$/gm)].map((match) => match[1]);
        return `patch ${files.join(", ") || "(no files)"}\n${patch.slice(0, 1_500)}`;
      },
      execute: async (args, ctx) => {
        const result = await workspace.applyPatch(stringArg(args, "patch"), ctx.agent);
        return { ok: true, output: result.message, meta: { modifiedFiles: result.modifiedFiles } };
      },
    },
    {
      spec: {
        name: "run_command",
        description: "Run a program in the workspace and get its exit code and output. Prefer argv (no shell, e.g. [\"npm\",\"test\"]); use command only when you need shell features. Non-zero exit is reported as a failure with output.",
        parameters: objectSchema({
          argv: { type: "array", items: { type: "string" } },
          command: { type: "string", description: "Shell command string (pipes, redirection)" },
          cwd: { type: "string", description: "Workspace-relative working directory" },
          timeout_ms: { type: "number" },
        }),
      },
      mutating: true,
      permission: "execute",
      command: (args) => {
        const spec = execSpec(args);
        return spec.argv ?? spec.command;
      },
      summarize: (args) => {
        const spec = execSpec(args);
        return `${spec.argv ? spec.argv.join(" ") : `sh -c ${spec.command}`}${typeof args.cwd === "string" ? ` (in ${args.cwd})` : ""}`;
      },
      execute: (args, ctx) => {
        const cwd = stringArg(args, "cwd", false);
        const timeout = numberArg(args, "timeout_ms", 0);
        return runCommand({ ...execSpec(args), ...(cwd ? { cwd } : {}), ...(timeout > 0 ? { timeoutMs: timeout } : {}) }, ctx.signal);
      },
    },
    {
      spec: {
        name: "run_check",
        description: checkNames.length
          ? `Run a project verification command by name: ${checkNames.map((name) => `${name} (${context.checks[name]})`).join("; ")}.`
          : "Run a named project verification command. None were detected; use run_command instead.",
        parameters: objectSchema({ name: { type: "string", ...(checkNames.length ? { enum: checkNames } : {}) } }, ["name"]),
      },
      mutating: true,
      permission: "execute",
      command: (args) => {
        const name = stringArg(args, "name");
        const command = context.checks[name];
        if (!command) throw new ToolError(`Unknown check "${name}". Available: ${checkNames.join(", ") || "none"}`);
        return command;
      },
      summarize: (args) => `check ${String(args.name)}: ${context.checks[String(args.name)] ?? "?"}`,
      execute: (args, ctx) => {
        const name = stringArg(args, "name");
        const command = context.checks[name];
        if (!command) throw new ToolError(`Unknown check "${name}".`);
        return runCommand({ command }, ctx.signal, name);
      },
    },
    {
      spec: {
        name: "git_status",
        description: "Show the Git branch and short status, including untracked files.",
        parameters: objectSchema({}),
      },
      mutating: false,
      permission: "read",
      execute: async () => ({ ok: true, output: await workspace.status() }),
    },
    {
      spec: {
        name: "git_diff",
        description: "Show the Git diff of working-tree changes (or staged changes, or against a base revision). Lists untracked files.",
        parameters: objectSchema({
          path: { type: "string" },
          staged: { type: "boolean" },
          base: { type: "string", description: "Compare the working tree with this revision, e.g. HEAD~1" },
          stat: { type: "boolean", description: "Only show a per-file summary" },
        }),
      },
      mutating: false,
      permission: "read",
      execute: async (args) => {
        const path = stringArg(args, "path", false);
        const base = stringArg(args, "base", false);
        return { ok: true, output: await workspace.diff({ staged: booleanArg(args, "staged"), stat: booleanArg(args, "stat"), ...(path ? { path } : {}), ...(base ? { base } : {}) }) };
      },
    },
    {
      spec: {
        name: "process_start",
        description: "Start a long-running background process (dev server, watcher). Returns an id for process_output/process_stop. Use run_command for anything that terminates.",
        parameters: objectSchema({ argv: { type: "array", items: { type: "string" } }, command: { type: "string" }, cwd: { type: "string" } }),
      },
      mutating: true,
      permission: "execute",
      command: (args) => {
        const spec = execSpec(args);
        return spec.argv ?? spec.command;
      },
      execute: async (args, ctx) => {
        const cwd = stringArg(args, "cwd", false);
        const id = processes.start(workspace, { ...execSpec(args), ...(cwd ? { cwd } : {}) }, ctx.agent);
        return { ok: true, output: `Started background process ${id}.` };
      },
    },
    {
      spec: {
        name: "process_output",
        description: "Read new output from a background process (optionally wait up to wait_ms for it to exit).",
        parameters: objectSchema({ id: { type: "string" }, wait_ms: { type: "number" } }, ["id"]),
      },
      mutating: false,
      permission: "read",
      execute: async (args) => ({ ok: true, output: await processes.output(stringArg(args, "id"), numberArg(args, "wait_ms", 0)) }),
    },
    {
      spec: {
        name: "process_stop",
        description: "Stop a background process and its child processes.",
        parameters: objectSchema({ id: { type: "string" } }, ["id"]),
      },
      mutating: false,
      permission: "read",
      execute: async (args) => ({ ok: true, output: await processes.stop(stringArg(args, "id")) }),
    },
    {
      spec: {
        name: "update_plan",
        description: "Record your plan and key decisions. This state survives context compaction; keep it current for multi-step work.",
        parameters: objectSchema({
          plan: {
            type: "array",
            items: objectSchema({ step: { type: "string" }, status: { type: "string", enum: ["pending", "in_progress", "done", "blocked"] } }, ["step", "status"]),
          },
          decisions: { type: "array", items: { type: "string" }, description: "New technical decisions to remember" },
        }),
      },
      mutating: false,
      permission: "read",
      execute: async (args) => {
        const plan = Array.isArray(args.plan) ? (args.plan as Array<Record<string, unknown>>).map((item) => {
          const status = String(item.status);
          if (!["pending", "in_progress", "done", "blocked"].includes(status)) throw new ToolError(`Invalid plan status "${status}".`);
          return { step: stringArg(item, "step"), status } as PlanStep;
        }) : undefined;
        taskState.updatePlan(plan, stringArrayArg(args, "decisions"));
        return { ok: true, output: `Plan recorded.\n${taskState.render()}` };
      },
    },
    {
      spec: {
        name: "share_note",
        description: "Publish or update a concise note for the team. kind: note|finding|decision|task. scope: session (default) or project (persists across sessions; never store secrets). Pass expected_version to replace another agent's note.",
        parameters: objectSchema({
          key: { type: "string" },
          text: { type: "string" },
          kind: { type: "string", enum: ["note", "finding", "decision", "task"] },
          scope: { type: "string", enum: ["session", "project"] },
          expected_version: { type: "number" },
        }, ["key", "text"]),
      },
      mutating: false,
      permission: "read",
      execute: async (args, ctx) => {
        const expected = numberArg(args, "expected_version", Number.NaN);
        const entry = await memory.write({
          key: stringArg(args, "key"),
          text: stringArg(args, "text"),
          author: ctx.agent,
          kind: (stringArg(args, "kind", false) || "note") as MemoryKind,
          scope: (stringArg(args, "scope", false) || "session") as MemoryScope,
          ...(Number.isFinite(expected) ? { expectedVersion: expected } : {}),
        });
        return { ok: true, output: `Shared note "${entry.key}" saved (version ${entry.version}, ${entry.scope}).` };
      },
    },
    {
      spec: {
        name: "read_notes",
        description: "Read team notes, most relevant first. Filter with query and kind.",
        parameters: objectSchema({
          query: { type: "string" },
          kind: { type: "string", enum: ["note", "finding", "decision", "task"] },
          limit: { type: "number" },
        }),
      },
      mutating: false,
      permission: "read",
      execute: async (args) => {
        const kind = stringArg(args, "kind", false) as MemoryKind | "";
        return {
          ok: true,
          output: memory.render(memory.search(stringArg(args, "query", false), { ...(kind ? { kind } : {}), limit: numberArg(args, "limit", 20) })),
        };
      },
    },
  ];
}

export function addBuiltinTools(registry: ToolRegistry, context: BuiltinContext): ToolRegistry {
  for (const tool of builtinTools(context)) registry.add(tool);
  return registry;
}
