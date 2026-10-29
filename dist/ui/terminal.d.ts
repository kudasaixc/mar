import { type Interface } from "node:readline/promises";
import type { ApprovalHandler } from "../tools/types.js";
import type { RuntimeEvent } from "../types.js";
export declare const colors: {
    cyan: (text: string) => string;
    green: (text: string) => string;
    yellow: (text: string) => string;
    red: (text: string) => string;
    gray: (text: string) => string;
    bold: (text: string) => string;
};
export declare function createTerminal(): Interface;
/**
 * Serialized approval prompts. Without an interactive terminal nothing can be
 * approved, so requests are denied immediately instead of hanging.
 */
export declare class ApprovalPrompt {
    private readonly terminal;
    private readonly interactive;
    private tail;
    constructor(terminal: Interface | undefined, interactive?: boolean);
    readonly handler: ApprovalHandler;
}
/**
 * Incremental renderer for runtime events. Concise mode shows streamed text,
 * one line per tool call, and warnings; verbose mode adds reasoning, tool
 * previews, retries, usage, and policy decisions.
 */
export declare class Renderer {
    private readonly options;
    private streaming;
    private lastAgent;
    constructor(options?: {
        verbose: boolean;
        write?: (text: string) => void;
    });
    private write;
    private endStream;
    private tag;
    readonly handle: (event: RuntimeEvent) => void;
}
/** Backwards-compatible concise printer. */
export declare function printEvent(event: RuntimeEvent): void;
export declare function banner(): string;
//# sourceMappingURL=terminal.d.ts.map