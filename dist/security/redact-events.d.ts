import type { RuntimeEventHandler } from "../types.js";
import type { Redactor } from "./redact.js";
/**
 * Redacts every human-visible field of runtime events before they reach the
 * terminal or any other listener. Stream deltas are buffered up to the last
 * whitespace so a token split across chunks is still recognized; a secret that
 * itself contains whitespace may only be caught in the final (non-streamed) text.
 */
export declare function redactEvents(handler: RuntimeEventHandler, redactor: Redactor): RuntimeEventHandler;
//# sourceMappingURL=redact-events.d.ts.map