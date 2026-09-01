import type { ToolDefinition } from "./types.js";
import { numberArg, stringArg, ToolRegistry } from "./registry.js";
import type { Workspace } from "./workspace.js";

const objectSchema = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

export class SharedNotes {
  private readonly notes = new Map<string, { author: string; text: string; updatedAt: string }>();

  set(key: string, author: string, text: string): void {
    this.notes.set(key, { author, text, updatedAt: new Date().toISOString() });
  }

  render(): string {
    if (!this.notes.size) return "No shared notes yet.";
    return [...this.notes.entries()].map(([key, note]) => `## ${key}\nBy ${note.author} at ${note.updatedAt}\n${note.text}`).join("\n\n");
  }
}

export function addBuiltinTools(registry: ToolRegistry, workspace: Workspace, notes: SharedNotes): ToolRegistry {
  const tools: ToolDefinition[] = [
    {
      spec: {
        name: "list_files",
        description: "List files and directories inside the shared workspace.",
        parameters: objectSchema({
          path: { type: "string", description: "Workspace-relative directory (default: .)" },
          depth: { type: "number", description: "Maximum traversal depth, up to 8" },
        }),
      },
      mutating: false,
      execute: async (args) => ({ ok: true, output: await workspace.list(stringArg(args, "path", false) || ".", numberArg(args, "depth", 4)) }),
    },
    {
      spec: {
        name: "read_file",
        description: "Read a UTF-8 file with line numbers. Read focused ranges for large files.",
        parameters: objectSchema({
          path: { type: "string" },
          start_line: { type: "number" },
          end_line: { type: "number" },
        }, ["path"]),
      },
      mutating: false,
      execute: async (args) => ({
        ok: true,
        output: await workspace.read(stringArg(args, "path"), numberArg(args, "start_line", 1), numberArg(args, "end_line", 500)),
      }),
    },
    {
      spec: {
        name: "search",
        description: "Search text recursively with a regular expression inside the workspace.",
        parameters: objectSchema({
          pattern: { type: "string" },
          path: { type: "string" },
          glob: { type: "string", description: "Optional file glob, e.g. *.ts" },
        }, ["pattern"]),
      },
      mutating: false,
      execute: async (args) => ({
        ok: true,
        output: await workspace.search(stringArg(args, "pattern"), stringArg(args, "path", false) || ".", stringArg(args, "glob", false) || undefined),
      }),
    },
    {
      spec: {
        name: "write_file",
        description: "Create or fully overwrite a UTF-8 file inside the workspace, atomically.",
        parameters: objectSchema({ path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
      },
      mutating: true,
      execute: async (args) => ({ ok: true, output: await workspace.write(stringArg(args, "path"), stringArg(args, "content")) }),
    },
    {
      spec: {
        name: "edit_file",
        description: "Replace an exact text fragment in a file. The match must be unique unless all=true.",
        parameters: objectSchema({
          path: { type: "string" },
          old_text: { type: "string" },
          new_text: { type: "string" },
          all: { type: "boolean" },
        }, ["path", "old_text", "new_text"]),
      },
      mutating: true,
      execute: async (args) => ({
        ok: true,
        output: await workspace.replace(stringArg(args, "path"), stringArg(args, "old_text"), stringArg(args, "new_text"), args.all === true),
      }),
    },
    {
      spec: {
        name: "run_command",
        description: "Run a shell command in the workspace. Destructive baseline patterns are always blocked.",
        parameters: objectSchema({ command: { type: "string" } }, ["command"]),
      },
      mutating: true,
      execute: async (args) => ({ ok: true, output: await workspace.run(stringArg(args, "command")) }),
    },
    {
      spec: {
        name: "git_diff",
        description: "Show the current unstaged Git diff without modifying the repository.",
        parameters: objectSchema({}),
      },
      mutating: false,
      execute: async () => ({ ok: true, output: await workspace.diff() }),
    },
    {
      spec: {
        name: "share_note",
        description: "Publish or update a concise finding on the in-memory team blackboard.",
        parameters: objectSchema({ key: { type: "string" }, text: { type: "string" } }, ["key", "text"]),
      },
      mutating: false,
      execute: async (args, context) => {
        notes.set(stringArg(args, "key"), context.agent, stringArg(args, "text"));
        return { ok: true, output: "Shared note updated." };
      },
    },
    {
      spec: {
        name: "read_notes",
        description: "Read the shared in-memory team blackboard.",
        parameters: objectSchema({}),
      },
      mutating: false,
      execute: async () => ({ ok: true, output: notes.render() }),
    },
  ];
  for (const tool of tools) registry.add(tool);
  return registry;
}
