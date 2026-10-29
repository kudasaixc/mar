/**
 * Best-effort secret redaction for logs, session journals, persisted memory and
 * tool output returned to models. It recognizes the values of sensitive
 * environment variables plus common credential formats. It cannot recognize
 * every secret, so it is a safeguard, not a guarantee.
 */
const SENSITIVE_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION)/i;
const PATTERNS = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g,
    /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
    /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
    /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
    /\bAKIA[0-9A-Z]{16}\b/g,
    /\bAIza[0-9A-Za-z_-]{35}\b/g,
    /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
    /\bnpm_[A-Za-z0-9]{36}\b/g,
    /(\b(?:authorization|x-api-key|x-goog-api-key)\s*[:=]\s*)(?:Bearer\s+)?[^\s"',]{8,}/gi,
];
export class Redactor {
    values;
    constructor(secrets = []) {
        this.values = [...new Set([...secrets].filter((value) => value.length >= 8))].sort((a, b) => b.length - a.length);
    }
    /** Build a redactor from sensitive-looking environment variables and explicitly named ones. */
    static fromEnvironment(env = process.env, extraNames = []) {
        const names = new Set(extraNames);
        const secrets = [];
        for (const [name, value] of Object.entries(env)) {
            if (!value)
                continue;
            if (names.has(name) || SENSITIVE_NAME.test(name))
                secrets.push(value);
        }
        return new Redactor(secrets);
    }
    redact(text) {
        if (!text)
            return text;
        let result = text;
        for (const value of this.values)
            result = result.split(value).join("[REDACTED]");
        for (const pattern of PATTERNS) {
            result = result.replace(pattern, (match, prefix) => typeof prefix === "string" && match.startsWith(prefix) ? `${prefix}[REDACTED]` : "[REDACTED]");
        }
        return result;
    }
    /** Deep-redact JSON-compatible data. */
    redactValue(value) {
        if (typeof value === "string")
            return this.redact(value);
        if (Array.isArray(value))
            return value.map((item) => this.redactValue(item));
        if (value && typeof value === "object") {
            const out = {};
            for (const [key, item] of Object.entries(value))
                out[key] = this.redactValue(item);
            return out;
        }
        return value;
    }
}
export const NO_REDACTION = new Redactor();
//# sourceMappingURL=redact.js.map