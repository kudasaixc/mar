import { createInterface, type Interface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { ApprovalAnswer, ApprovalHandler } from "../tools/types.js";
import type { RuntimeEvent } from "../types.js";
import { oneLine } from "../util/text.js";

const enabled = Boolean(stdout.isTTY) && !process.env.NO_COLOR;
const ansi = (code: number, text: string): string => enabled ? `\u001b[${code}m${text}\u001b[0m` : text;

export const colors = {
  cyan: (text: string) => ansi(36, text),
  green: (text: string) => ansi(32, text),
  yellow: (text: string) => ansi(33, text),
  red: (text: string) => ansi(31, text),
  gray: (text: string) => ansi(90, text),
  bold: (text: string) => ansi(1, text),
};

export function createTerminal(): Interface {
  return createInterface({ input: stdin, output: stdout, terminal: Boolean(stdout.isTTY) });
}

/**
 * Serialized approval prompts. Without an interactive terminal nothing can be
 * approved, so requests are denied immediately instead of hanging.
 */
export class ApprovalPrompt {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly terminal: Interface | undefined, private readonly interactive = Boolean(stdin.isTTY)) {}

  readonly handler: ApprovalHandler = (request) => {
    if (!this.terminal || !this.interactive) {
      stdout.write(`${colors.yellow("denied")} ${request.agent} → ${request.tool}: approval needed but no interactive terminal (use --yes, --approval auto-edit, or allowCommands)\n`);
      return Promise.resolve(false);
    }
    const terminal = this.terminal;
    const answer = this.tail.then(async (): Promise<ApprovalAnswer> => {
      const where = request.isolated === false && request.permission === "execute" ? colors.red(" (runs on the host, not sandboxed)") : "";
      stdout.write(`\n${colors.yellow("approval required")} ${colors.bold(request.agent)} → ${request.tool}${where}\n${request.detail}\n`);
      if (request.reason) stdout.write(`${colors.gray(request.reason)}\n`);
      const value = (await terminal.question("Allow? [y]es once / [a]lways for this command / [N]o: ")).trim();
      if (/^(a|always|toujours)$/i.test(value)) return "always";
      return /^(y|yes|o|oui)$/i.test(value);
    });
    this.tail = answer.catch(() => undefined);
    return answer;
  };
}

/**
 * Incremental renderer for runtime events. Concise mode shows streamed text,
 * one line per tool call, and warnings; verbose mode adds reasoning, tool
 * previews, retries, usage, and policy decisions.
 */
export class Renderer {
  private streaming: string | undefined;
  private lastAgent: string | undefined;

  constructor(private readonly options: { verbose: boolean; write?: (text: string) => void } = { verbose: false }) {}

  private write(text: string): void {
    (this.options.write ?? ((value: string) => stdout.write(value)))(text);
  }

  private endStream(): void {
    if (this.streaming !== undefined) {
      this.write("\n");
      this.streaming = undefined;
    }
  }

  private tag(agent: string): string {
    return colors.cyan(`[${agent}]`);
  }

  readonly handle = (event: RuntimeEvent): void => {
    const verbose = this.options.verbose;
    switch (event.type) {
      case "agent:start":
        this.endStream();
        this.write(`\n${this.tag(event.agent)} ${colors.gray(event.model)}\n`);
        this.lastAgent = event.agent;
        break;
      case "agent:delta":
        if (this.streaming !== event.agent) {
          this.endStream();
          if (this.lastAgent !== event.agent) this.write(`${this.tag(event.agent)} `);
          this.streaming = event.agent;
          this.lastAgent = event.agent;
        }
        this.write(event.text);
        break;
      case "agent:reasoning":
        if (verbose) this.write(colors.gray(event.text));
        break;
      case "agent:stream-reset":
        this.endStream();
        this.write(`${colors.yellow("  ↻ stream interrupted; retrying (text above is discarded)")}\n`);
        break;
      case "agent:text":
        if (event.streamed) this.endStream();
        else {
          this.endStream();
          if (this.lastAgent !== event.agent) this.write(`${this.tag(event.agent)} `);
          this.write(`${event.text}\n`);
        }
        this.lastAgent = event.agent;
        break;
      case "agent:tool":
        this.endStream();
        this.write(`${colors.gray(`  ${event.agent} →`)} ${colors.yellow(event.tool)} ${colors.gray(oneLine(event.detail, verbose ? 300 : 100))}\n`);
        break;
      case "agent:tool-result":
        this.endStream();
        if (verbose || !event.ok) {
          this.write(`${event.ok ? colors.green("  ✓") : colors.red("  ✗")} ${event.tool} ${colors.gray(`${(event.durationMs / 1000).toFixed(1)}s`)} ${colors.gray(oneLine(event.preview, verbose ? 300 : 160))}\n`);
        }
        break;
      case "agent:fallback":
        this.endStream();
        this.write(`${colors.yellow("  ↻ fallback")} ${event.agent}: ${event.model} failed: ${event.error}\n`);
        break;
      case "agent:retry":
        this.endStream();
        if (verbose) this.write(`${colors.yellow("  ↻ retry")} ${event.model} attempt ${event.attempt} in ${(event.delayMs / 1000).toFixed(1)}s: ${event.error}\n`);
        break;
      case "agent:compaction":
        this.endStream();
        this.write(`${colors.gray(`  ⇣ ${event.agent} context compacted ${event.beforeTokens} → ${event.afterTokens} tokens (${event.strategy})`)}\n`);
        break;
      case "agent:usage":
        if (verbose) {
          this.endStream();
          const percent = event.contextWindow ? Math.round((event.contextTokens / event.contextWindow) * 100) : 0;
          this.write(`${colors.gray(`  · ${event.agent} in ${event.inputTokens} / out ${event.outputTokens} tokens · context ${percent}% of ${event.contextWindow}`)}\n`);
        }
        break;
      case "agent:warning":
        this.endStream();
        this.write(`${colors.yellow("  ! ")}${event.agent}: ${event.message}\n`);
        break;
      case "agent:end":
        this.endStream();
        if (verbose || event.status !== "completed") {
          const text = `[${event.agent} ${event.status} after ${event.turns} turn(s)]`;
          this.write(`${event.status === "completed" ? colors.gray(text) : colors.yellow(text)}\n`);
        }
        break;
      case "task:update":
        this.endStream();
        this.write(`${colors.gray("  ◆")} ${event.taskId} ${event.agent}: ${statusColor(event.status)}${event.detail ? colors.gray(` — ${event.detail}`) : ""}\n`);
        break;
      case "policy:decision":
        if (verbose && event.decision !== "allow") {
          this.endStream();
          this.write(`${colors.gray(`  policy ${event.decision}${event.approved === undefined ? "" : event.approved ? " (approved)" : " (refused)"}: ${event.tool} — ${event.reason}`)}\n`);
        }
        break;
    }
  };
}

function statusColor(status: string): string {
  if (status === "completed" || status === "integrated") return colors.green(status);
  if (status === "running" || status === "pending") return colors.cyan(status);
  return colors.yellow(status);
}

/** Backwards-compatible concise printer. */
export function printEvent(event: RuntimeEvent): void {
  defaultRenderer.handle(event);
}
const defaultRenderer = new Renderer();

export function banner(): string {
  return `${colors.cyan(colors.bold("MAR"))}  ${colors.gray("Multi-Agent Router")}`;
}
