/**
 * Redacts every human-visible field of runtime events before they reach the
 * terminal or any other listener. Stream deltas are buffered up to the last
 * whitespace so a token split across chunks is still recognized; a secret that
 * itself contains whitespace may only be caught in the final (non-streamed) text.
 */
export function redactEvents(handler, redactor) {
    const pending = new Map();
    const flush = (agent) => {
        const rest = pending.get(agent);
        pending.delete(agent);
        if (rest)
            handler({ type: "agent:delta", agent, text: redactor.redact(rest) });
    };
    return (event) => {
        switch (event.type) {
            case "agent:delta":
            case "agent:reasoning": {
                if (event.type === "agent:reasoning") {
                    handler({ ...event, text: redactor.redact(event.text) });
                    return;
                }
                const buffer = (pending.get(event.agent) ?? "") + event.text;
                const cut = Math.max(buffer.lastIndexOf(" "), buffer.lastIndexOf("\n"), buffer.lastIndexOf("\t"));
                if (cut < 0 && buffer.length < 512) {
                    pending.set(event.agent, buffer);
                    return;
                }
                const emit = cut < 0 ? buffer : buffer.slice(0, cut + 1);
                pending.set(event.agent, cut < 0 ? "" : buffer.slice(cut + 1));
                handler({ ...event, text: redactor.redact(emit) });
                return;
            }
            case "agent:stream-reset":
                pending.delete(event.agent);
                handler(event);
                return;
            case "agent:text":
                flush(event.agent);
                handler({ ...event, text: redactor.redact(event.text) });
                return;
            case "agent:end":
                flush(event.agent);
                handler(event);
                return;
            case "agent:tool":
                flush(event.agent);
                handler({ ...event, detail: redactor.redact(event.detail) });
                return;
            case "agent:tool-result":
                handler({ ...event, preview: redactor.redact(event.preview) });
                return;
            case "agent:fallback":
            case "agent:retry":
                handler({ ...event, error: redactor.redact(event.error) });
                return;
            case "agent:warning":
                handler({ ...event, message: redactor.redact(event.message) });
                return;
            case "task:update":
                handler(event.detail ? { ...event, detail: redactor.redact(event.detail) } : event);
                return;
            case "policy:decision":
                handler({ ...event, reason: redactor.redact(event.reason) });
                return;
            default:
                handler(event);
        }
    };
}
//# sourceMappingURL=redact-events.js.map