import type { ChatMessage, ToolSpec } from "../types.js";
/**
 * Conservative token estimate. Real tokenizers average ~4 characters per token for
 * English and code; MAR assumes 3.2 for ASCII and 1 token per non-ASCII character
 * so that estimates err high. Provider-reported usage calibrates it at runtime.
 */
export declare function estimateText(text: string): number;
export declare function estimateMessage(message: ChatMessage): number;
export declare function estimateMessages(messages: readonly ChatMessage[]): number;
export declare function estimateTools(tools: readonly ToolSpec[]): number;
/**
 * Tracks the most recent provider-reported prompt size. When the conversation has
 * only grown since that request, the next prompt size is the reported value plus
 * an estimate for the new messages, which is far more accurate than a pure estimate.
 */
export declare class TokenAccountant {
    private anchor;
    private ratio;
    observe(actualInput: number | undefined, messages: readonly ChatMessage[], estimated: number): void;
    /** Forget the anchor after the history is rewritten (compaction, reset, resume). */
    invalidate(): void;
    /** Raise the calibration ratio after a provider rejected a prompt as too long. */
    penalize(): void;
    estimate(messages: readonly ChatMessage[], tools: readonly ToolSpec[]): {
        tokens: number;
        exact: boolean;
    };
}
//# sourceMappingURL=tokens.d.ts.map