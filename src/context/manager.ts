import { ContextOverflowError } from "../errors.js";
import type { ChatMessage, ContextSettings, ModelCapabilities, ToolSpec } from "../types.js";
import { oneLine, truncateMiddle } from "../util/text.js";
import type { TaskState } from "./task-state.js";
import { TokenAccountant } from "./tokens.js";

export const SUMMARY_HEADER = "# Earlier conversation (compacted by MAR)";
const MAX_NARRATIVE_CHARS = 8_000;
const SUMMARIZER_INPUT_CHARS = 24_000;

export type Summarizer = (digest: string, signal?: AbortSignal) => Promise<string>;

export interface CompactionReport {
  compacted: boolean;
  beforeTokens: number;
  afterTokens: number;
  strategy: string;
  removedMessages: number;
  warnings: string[];
}

export interface ContextUsage {
  tokens: number;
  exact: boolean;
  window: number;
  usable: number;
  threshold: number;
  compactions: number;
}

interface Unit {
  start: number;
  end: number;
  kind: "user" | "assistant" | "summary";
}

/**
 * Keeps an agent conversation within its model's context window.
 *
 * Invariants preserved by every compaction:
 * - the base system prompt is never modified;
 * - every user instruction is retained verbatim (inside the summary once its turn is compacted);
 * - the structured task state (objective, plan, decisions, modified files,
 *   unresolved failures, verification state) is embedded in the summary;
 * - an assistant message with tool calls is never separated from its tool results.
 */
export class ContextManager {
  readonly accountant = new TokenAccountant();
  private narrative = "";
  private compactions = 0;

  constructor(
    private readonly settings: ContextSettings,
    private readonly capabilities: ModelCapabilities,
    private readonly maxOutputTokens: number,
  ) {}

  get window(): number {
    return this.capabilities.contextWindow;
  }

  /** Tokens available for the prompt once the response budget is reserved. */
  get usable(): number {
    return Math.max(1_024, this.capabilities.contextWindow - Math.min(this.maxOutputTokens, Math.floor(this.capabilities.contextWindow / 2)));
  }

  usage(messages: readonly ChatMessage[], tools: readonly ToolSpec[]): ContextUsage {
    const estimate = this.accountant.estimate(messages, tools);
    return {
      tokens: estimate.tokens,
      exact: estimate.exact,
      window: this.window,
      usable: this.usable,
      threshold: Math.floor(this.usable * this.settings.compactAt),
      compactions: this.compactions,
    };
  }

  needsCompaction(messages: readonly ChatMessage[], tools: readonly ToolSpec[]): boolean {
    return this.accountant.estimate(messages, tools).tokens > this.usable * this.settings.compactAt;
  }

  /** Restore narrative state from a resumed history. */
  restore(messages: readonly ChatMessage[]): void {
    const summary = messages.find((message) => message.meta?.summary);
    const match = summary?.content.split("\n## Narrative of earlier work\n")[1];
    this.narrative = match ? match.trim() : "";
    this.accountant.invalidate();
  }

  /**
   * Compact `messages` in place when over budget (or when `force` is set after a
   * provider overflow error). Returns a report; throws ContextOverflowError when
   * even maximal compaction cannot fit the pinned content.
   */
  async compact(
    messages: ChatMessage[],
    tools: readonly ToolSpec[],
    state: TaskState,
    options: { force?: boolean; summarizer?: Summarizer; signal?: AbortSignal } = {},
  ): Promise<CompactionReport> {
    const measure = (): number => this.accountant.estimate(messages, tools).tokens;
    const before = measure();
    const report: CompactionReport = { compacted: false, beforeTokens: before, afterTokens: before, strategy: "none", removedMessages: 0, warnings: [] };
    if (!options.force && before <= this.usable * this.settings.compactAt) return report;
    const target = this.usable * this.settings.targetAfterCompaction;
    const steps: string[] = [];
    this.accountant.invalidate();

    // 1. Elide bulky tool output outside the most recent turns.
    const keep = options.force ? 1 : this.settings.keepRecentTurns;
    if (this.elide(messages, keep, this.settings.maxToolResultChars)) steps.push("elide-old-tool-output");
    if (!options.force && measure() <= target) return this.finish(report, messages, tools, steps);

    // 2. Replace older turns with a structured summary.
    for (let recent = keep; recent >= 1; recent -= 1) {
      const removed = await this.summarize(messages, recent, state, options.summarizer, options.signal, report);
      if (removed) {
        report.removedMessages += removed;
        if (!steps.includes("summarize")) steps.push("summarize");
      }
      if (measure() <= target) return this.finish(report, messages, tools, steps);
    }

    // 3. Shrink tool output everywhere except the newest turn.
    if (this.elide(messages, 1, 600)) steps.push("elide-recent-tool-output");
    if (measure() <= this.usable * 0.95) return this.finish(report, messages, tools, steps);

    // 4. Last resort: shrink the newest tool outputs and very long pinned instructions, explicitly.
    if (this.elide(messages, 0, 400)) steps.push("elide-all-tool-output");
    if (measure() > this.usable * 0.95) {
      const shrunk = this.shrinkInstructions(messages);
      if (shrunk) {
        steps.push("truncate-long-instructions");
        report.warnings.push("Some very long user instructions were truncated to fit the context window; their full text remains in the session journal.");
      }
    }
    if (measure() > this.usable) {
      throw new ContextOverflowError(
        `Context still needs ~${measure()} tokens after compaction but the model allows ~${this.usable}. ` +
        "Use a model with a larger context window, raise capabilities.contextWindow if it is underestimated, or split the task.");
    }
    return this.finish(report, messages, tools, steps);
  }

  private finish(report: CompactionReport, messages: ChatMessage[], tools: readonly ToolSpec[], steps: string[]): CompactionReport {
    report.afterTokens = this.accountant.estimate(messages, tools).tokens;
    report.compacted = steps.length > 0;
    report.strategy = steps.join("+") || "none";
    if (report.compacted) this.compactions += 1;
    return report;
  }

  private units(messages: readonly ChatMessage[]): Unit[] {
    const units: Unit[] = [];
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index]!;
      if (message.role === "system") {
        if (message.meta?.summary) units.push({ start: index, end: index + 1, kind: "summary" });
        continue;
      }
      if (message.role === "assistant") {
        let end = index + 1;
        while (end < messages.length && messages[end]!.role === "tool") end += 1;
        units.push({ start: index, end, kind: "assistant" });
        index = end - 1;
        continue;
      }
      // A user message (or an orphan tool message) forms its own unit.
      units.push({ start: index, end: index + 1, kind: "user" });
    }
    return units;
  }

  /** Shorten tool results outside the last `keepRecent` assistant turns. */
  private elide(messages: ChatMessage[], keepRecent: number, limit: number): boolean {
    const assistantUnits = this.units(messages).filter((unit) => unit.kind === "assistant");
    const protectedFrom = keepRecent > 0 ? assistantUnits.at(-keepRecent)?.start ?? 0 : messages.length;
    let changed = false;
    for (let index = 0; index < Math.min(protectedFrom, messages.length); index += 1) {
      const message = messages[index]!;
      if (message.role !== "tool") continue;
      const max = message.isError ? limit * 2 : limit;
      if (message.content.length <= max) continue;
      messages[index] = {
        ...message,
        content: `${truncateMiddle(message.content, max)}\n[output elided by MAR context compaction; re-run the tool if the full output is needed]`,
        meta: { ...message.meta, elided: true },
      };
      changed = true;
    }
    return changed;
  }

  private async summarize(
    messages: ChatMessage[],
    keepRecent: number,
    state: TaskState,
    summarizer: Summarizer | undefined,
    signal: AbortSignal | undefined,
    report: CompactionReport,
  ): Promise<number> {
    const units = this.units(messages).filter((unit) => unit.kind !== "summary");
    const conversational = units.filter((unit) => unit.kind === "assistant");
    if (conversational.length <= keepRecent) return 0;
    const cut = conversational.at(-keepRecent)!.start;
    // Keep the user message that introduced the retained turns, if it is adjacent.
    let boundary = cut;
    while (boundary > 0 && messages[boundary - 1]!.role === "user") boundary -= 1;
    const firstContent = messages.findIndex((message) => message.role !== "system");
    if (firstContent < 0 || boundary <= firstContent) return 0;
    const removed = messages.slice(firstContent, boundary).filter((message) => !message.meta?.summary);
    if (!removed.length) return 0;

    const digest = this.digest(removed);
    let addition = truncateMiddle(digest, 3_000);
    if (summarizer) {
      try {
        const source = `${this.narrative ? `Previous summary:\n${this.narrative}\n\n` : ""}New events:\n${truncateMiddle(digest, SUMMARIZER_INPUT_CHARS)}`;
        const result = (await summarizer(source, signal)).trim();
        if (result) {
          this.narrative = truncateMiddle(result, MAX_NARRATIVE_CHARS);
          addition = "";
        } else report.warnings.push("Model summary was empty; used the deterministic digest.");
      } catch (error) {
        if (signal?.aborted) throw error;
        report.warnings.push(`Model summary failed (${error instanceof Error ? error.message : String(error)}); used the deterministic digest.`);
      }
    }
    if (addition) {
      const combined = this.narrative ? `${this.narrative}\n${addition}` : addition;
      this.narrative = combined.length > MAX_NARRATIVE_CHARS
        ? `[older narrative truncated]\n${combined.slice(-MAX_NARRATIVE_CHARS)}`
        : combined;
    }

    const kept = messages.slice(boundary);
    const keptUser = new Set(kept.filter((message) => message.role === "user").map((message) => message.content));
    const instructions = state.instructions.filter((text) => !keptUser.has(text));
    const summary: ChatMessage = {
      role: "system",
      content: [
        SUMMARY_HEADER,
        `${state.instructions.length} user instruction(s) so far; ${this.compactions + 1} compaction(s). Tool outputs from compacted turns are gone: re-read files or re-run commands instead of relying on memory.`,
        "## User instructions (verbatim, oldest first; all remain in force unless superseded)",
        instructions.length ? instructions.map((text, index) => `${index + 1}. ${text}`).join("\n\n") : "(all instructions appear in the recent messages below)",
        "## Task state",
        state.render(),
        "## Narrative of earlier work",
        this.narrative || "(none)",
      ].join("\n"),
      meta: { summary: true },
    };
    const systems = messages.slice(0, firstContent).filter((message) => !message.meta?.summary);
    messages.splice(0, messages.length, ...systems, summary, ...kept);
    return removed.length;
  }

  private digest(messages: readonly ChatMessage[]): string {
    const lines: string[] = [];
    const results = new Map<string, ChatMessage>();
    for (const message of messages) if (message.role === "tool" && message.toolCallId) results.set(message.toolCallId, message);
    for (const message of messages) {
      if (message.role === "user") lines.push(`USER: ${oneLine(message.content, 300)}`);
      if (message.role !== "assistant") continue;
      if (message.content) lines.push(`ASSISTANT: ${oneLine(message.content, 400)}`);
      for (const call of message.toolCalls ?? []) {
        const result = results.get(call.id);
        const outcome = result ? `${result.isError ? "FAILED" : "ok"}: ${oneLine(result.content, 160)}` : "no result recorded";
        lines.push(`  ${call.name}(${oneLine(JSON.stringify(call.arguments), 160)}) → ${outcome}`);
      }
    }
    return lines.join("\n");
  }

  private shrinkInstructions(messages: ChatMessage[]): boolean {
    const index = messages.findIndex((message) => message.meta?.summary);
    if (index < 0) return false;
    const message = messages[index]!;
    const sections = message.content.split("\n## ");
    const shrunk = sections.map((section) => section.startsWith("User instructions")
      ? section.split("\n\n").map((part) => part.length > 2_000 ? `${truncateMiddle(part, 2_000)}\n[instruction truncated by MAR to fit the context window]` : part).join("\n\n")
      : section).join("\n## ");
    if (shrunk === message.content) return false;
    messages[index] = { ...message, content: shrunk };
    return true;
  }
}

