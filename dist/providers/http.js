import { isContextOverflowMessage, kindFromStatus, ProviderError } from "../errors.js";
import { anySignal } from "../util/async.js";
export function joinUrl(base, path) {
    return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}
export function requireApiKey(providerId, envName) {
    if (!envName)
        return undefined;
    const value = process.env[envName];
    if (!value) {
        throw new ProviderError(`Provider "${providerId}" requires environment variable ${envName}.`, undefined, undefined, "auth");
    }
    return value;
}
function retryAfter(response) {
    const header = response.headers.get("retry-after-ms") ?? response.headers.get("retry-after");
    if (!header)
        return undefined;
    const seconds = Number(header);
    if (Number.isFinite(seconds))
        return response.headers.has("retry-after-ms") ? seconds : seconds * 1000;
    const date = Date.parse(header);
    return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}
function detailFrom(body, text) {
    const value = body;
    const raw = value?.error?.message ?? value?.error ?? value?.message ?? value?.detail ?? text.slice(0, 500);
    return typeof raw === "string" ? raw : JSON.stringify(raw).slice(0, 500);
}
export function httpError(response, text) {
    let body;
    try {
        body = text ? JSON.parse(text) : undefined;
    }
    catch {
        body = undefined;
    }
    const detail = detailFrom(body, text);
    const typed = body?.error?.type;
    let kind = kindFromStatus(response.status, detail);
    if (typed === "overloaded_error")
        kind = "overloaded";
    if (kind === "bad_request" && isContextOverflowMessage(detail))
        kind = "context_overflow";
    return new ProviderError(`Provider returned HTTP ${response.status}: ${detail}`, response.status, undefined, kind, retryAfter(response));
}
/** fetch with timeout, user cancellation, and normalized errors. The caller consumes the body. */
export async function request(url, init, options = {}) {
    const timeoutMs = options.timeoutMs ?? 180_000;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    const combined = anySignal(options.signal, timeout.signal);
    const dispose = () => {
        clearTimeout(timer);
        combined.dispose();
    };
    try {
        const response = await fetch(url, { ...init, signal: combined.signal });
        if (!response.ok) {
            const text = await response.text().catch(() => "");
            throw httpError(response, text);
        }
        return { response, dispose };
    }
    catch (error) {
        dispose();
        throw normalizeFetchError(error, options.signal, timeout.signal, timeoutMs);
    }
}
export function normalizeFetchError(error, user, timeout, timeoutMs) {
    if (error instanceof ProviderError)
        return error;
    if (user?.aborted)
        return new ProviderError("Request cancelled.", undefined, error, "cancelled");
    if (timeout?.aborted || (error instanceof Error && error.name === "TimeoutError")) {
        return new ProviderError(`Provider request timed out after ${timeoutMs}ms.`, undefined, error, "timeout");
    }
    const message = error instanceof Error ? `${error.message}${error.cause instanceof Error ? ` (${error.cause.message})` : ""}` : String(error);
    return new ProviderError(`Provider request failed: ${message}`, undefined, error, "network");
}
export async function fetchJson(url, init, timeoutMsOrOptions = 180_000) {
    const options = typeof timeoutMsOrOptions === "number" ? { timeoutMs: timeoutMsOrOptions } : timeoutMsOrOptions;
    const { response, dispose } = await request(url, init, options);
    try {
        const text = await response.text();
        try {
            const body = text ? JSON.parse(text) : {};
            if (typeof body !== "object" || body === null)
                throw new SyntaxError("not an object");
            return body;
        }
        catch {
            throw new ProviderError(`Provider returned a non-JSON response: ${text.slice(0, 200)}`, response.status, undefined, "malformed");
        }
    }
    catch (error) {
        throw normalizeFetchError(error, options.signal);
    }
    finally {
        dispose();
    }
}
/** Iterate lines of a streaming response body. */
async function* lines(body) {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of body) {
        buffer += decoder.decode(chunk, { stream: true });
        let index;
        while ((index = buffer.indexOf("\n")) >= 0) {
            yield buffer.slice(0, index).replace(/\r$/, "");
            buffer = buffer.slice(index + 1);
        }
    }
    buffer += decoder.decode();
    if (buffer)
        yield buffer;
}
/** Parse a Server-Sent Events stream. */
export async function* sse(response) {
    if (!response.body)
        throw new ProviderError("Streaming response has no body.", response.status, undefined, "malformed");
    let event;
    let data = [];
    for await (const line of lines(response.body)) {
        if (line === "") {
            if (data.length)
                yield { ...(event ? { event } : {}), data: data.join("\n") };
            event = undefined;
            data = [];
            continue;
        }
        if (line.startsWith(":"))
            continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event")
            event = value;
        else if (field === "data")
            data.push(value);
    }
    if (data.length)
        yield { ...(event ? { event } : {}), data: data.join("\n") };
}
/** Parse newline-delimited JSON (Ollama streaming). */
export async function* ndjson(response) {
    if (!response.body)
        throw new ProviderError("Streaming response has no body.", response.status, undefined, "malformed");
    for await (const line of lines(response.body)) {
        if (!line.trim())
            continue;
        yield parseJson(line);
    }
}
export function parseJson(text) {
    try {
        const value = JSON.parse(text);
        if (typeof value === "object" && value !== null)
            return value;
    }
    catch {
        // Reported below.
    }
    throw new ProviderError(`Malformed streaming chunk: ${text.slice(0, 200)}`, undefined, undefined, "malformed");
}
/** Run a streaming request, translating mid-stream failures into ProviderErrors. */
export async function streamRequest(url, init, options, consume) {
    const { response, dispose } = await request(url, init, options);
    try {
        return await consume(response);
    }
    catch (error) {
        throw normalizeFetchError(error, options.signal);
    }
    finally {
        dispose();
    }
}
export function parseArguments(value) {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        return value;
    }
    if (typeof value !== "string" || value.trim() === "")
        return {};
    try {
        const parsed = JSON.parse(value);
        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
            ? parsed
            : { value: parsed };
    }
    catch {
        return { raw: value };
    }
}
export function contentToString(content) {
    if (typeof content === "string")
        return content;
    if (!Array.isArray(content))
        return "";
    return content.map((part) => {
        if (typeof part === "string")
            return part;
        if (part && typeof part === "object" && "text" in part && typeof part.text === "string")
            return part.text;
        return "";
    }).join("");
}
let sequence = 0;
/** Unique tool-call identifier for providers that do not supply one. */
export function syntheticCallId(prefix = "call") {
    sequence = (sequence + 1) % 1_000_000;
    return `${prefix}_${Date.now().toString(36)}_${sequence.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
/** Ensure tool-call ids are present and unique within one response. */
export function uniqueCallIds(calls, prefix = "call") {
    const seen = new Set();
    return calls.map((call) => {
        let id = call.id;
        if (!id || seen.has(id))
            id = syntheticCallId(prefix);
        seen.add(id);
        return id === call.id ? call : { ...call, id };
    });
}
//# sourceMappingURL=http.js.map