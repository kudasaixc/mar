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
export declare class ApprovalPrompt {
    private readonly terminal;
    private tail;
    constructor(terminal: Interface);
    readonly handler: ApprovalHandler;
}
export declare function printEvent(event: RuntimeEvent): void;
export declare function banner(): string;
//# sourceMappingURL=terminal.d.ts.map