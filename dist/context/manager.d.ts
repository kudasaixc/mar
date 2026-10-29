import type { ChatMessage, ContextSettings, ModelCapabilities, ToolSpec } from "../types.js";
import type { TaskState } from "./task-state.js";
import { TokenAccountant } from "./tokens.js";
export declare const SUMMARY_HEADER = "# Earlier conversation (compacted by MAR)";
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
export declare class ContextManager {
    private readonly settings;
    private readonly capabilities;
    private readonly maxOutputTokens;
    readonly accountant: TokenAccountant;
    private narrative;
    private compactions;
    constructor(settings: ContextSettings, capabilities: ModelCapabilities, maxOutputTokens: number);
    get window(): number;
    /** Tokens available for the prompt once the response budget is reserved. */
    get usable(): number;
    usage(messages: readonly ChatMessage[], tools: readonly ToolSpec[]): ContextUsage;
    needsCompaction(messages: readonly ChatMessage[], tools: readonly ToolSpec[]): boolean;
    /** Restore narrative state from a resumed history. */
    restore(messages: readonly ChatMessage[]): void;
    /**
     * Compact `messages` in place when over budget (or when `force` is set after a
     * provider overflow error). Returns a report; throws ContextOverflowError when
     * even maximal compaction cannot fit the pinned content.
     */
    compact(messages: ChatMessage[], tools: readonly ToolSpec[], state: TaskState, options?: {
        force?: boolean;
        summarizer?: Summarizer;
        signal?: AbortSignal;
    }): Promise<CompactionReport>;
    private finish;
    private units;
    /** Shorten tool results outside the last `keepRecent` assistant turns. */
    private elide;
    private summarize;
    private digest;
    private shrinkInstructions;
}
//# sourceMappingURL=manager.d.ts.map