import type { ChatMessage, ToolSpec } from "../types.js";

/**
 * Conservative token estimate. Real tokenizers average ~4 characters per token for
 * English and code; MAR assumes 3.2 for ASCII and 1 token per non-ASCII character
 * so that estimates err high. Provider-reported usage calibrates it at runtime.
 */
export function estimateText(text: string): number {
  if (!text) return 0;
  let ascii = 0;
  let other = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) < 128) ascii += 1;
    else other += 1;
  }
  return Math.ceil(ascii / 3.2 + other);
}

export function estimateMessage(message: ChatMessage): number {
  let total = 6 + estimateText(message.content);
  if (message.toolCalls?.length) total += estimateText(JSON.stringify(message.toolCalls.map((call) => [call.name, call.arguments])));
  if (message.reasoning?.length) total += estimateText(JSON.stringify(message.reasoning));
  return total;
}

export function estimateMessages(messages: readonly ChatMessage[]): number {
  let total = 0;
  for (const message of messages) total += estimateMessage(message);
  return total;
}

export function estimateTools(tools: readonly ToolSpec[]): number {
  return tools.length ? estimateText(JSON.stringify(tools)) + tools.length * 8 : 0;
}

/**
 * Tracks the most recent provider-reported prompt size. When the conversation has
 * only grown since that request, the next prompt size is the reported value plus
 * an estimate for the new messages, which is far more accurate than a pure estimate.
 */
export class TokenAccountant {
  private anchor: { actual: number; messages: readonly ChatMessage[]; count: number } | undefined;
  private ratio = 1;

  observe(actualInput: number | undefined, messages: readonly ChatMessage[], estimated: number): void {
    if (actualInput === undefined || !Number.isFinite(actualInput) || actualInput <= 0) return;
    this.anchor = { actual: actualInput, messages, count: messages.length };
    if (estimated > 0) this.ratio = Math.min(1.5, Math.max(0.6, actualInput / estimated));
  }

  /** Forget the anchor after the history is rewritten (compaction, reset, resume). */
  invalidate(): void {
    this.anchor = undefined;
  }

  /** Raise the calibration ratio after a provider rejected a prompt as too long. */
  penalize(): void {
    this.ratio = Math.min(2, this.ratio * 1.3);
    this.anchor = undefined;
  }

  estimate(messages: readonly ChatMessage[], tools: readonly ToolSpec[]): { tokens: number; exact: boolean } {
    const anchor = this.anchor;
    if (anchor && anchor.messages === messages && messages.length >= anchor.count) {
      return { tokens: anchor.actual + Math.ceil(estimateMessages(messages.slice(anchor.count)) * Math.max(1, this.ratio)), exact: messages.length === anchor.count };
    }
    const raw = estimateMessages(messages) + estimateTools(tools);
    return { tokens: Math.ceil(raw * Math.max(this.ratio, 0.8)), exact: false };
  }
}
