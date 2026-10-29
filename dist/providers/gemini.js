import { ProviderError } from "../errors.js";
import { fetchJson, joinUrl, parseJson, requireApiKey, sse, streamRequest, uniqueCallIds } from "./http.js";
const SCHEMA_KEYS = new Set(["type", "format", "description", "nullable", "enum", "properties", "required", "items", "minimum", "maximum", "minItems", "maxItems", "anyOf", "title", "minLength", "maxLength", "pattern"]);
/** Gemini accepts an OpenAPI subset: drop unsupported JSON-Schema keywords such as additionalProperties. */
export function sanitizeSchema(schema) {
    if (Array.isArray(schema))
        return schema.map(sanitizeSchema);
    if (!schema || typeof schema !== "object")
        return schema;
    const out = {};
    for (const [key, value] of Object.entries(schema)) {
        if (!SCHEMA_KEYS.has(key))
            continue;
        if (key === "properties" && value && typeof value === "object") {
            out.properties = Object.fromEntries(Object.entries(value).map(([name, property]) => [name, sanitizeSchema(property)]));
        }
        else if (key === "items" || key === "anyOf")
            out[key] = sanitizeSchema(value);
        else
            out[key] = value;
    }
    if (out.type === "object" && Array.isArray(out.required) && out.properties && typeof out.properties === "object") {
        out.required = out.required.filter((name) => name in out.properties);
    }
    return out;
}
export function mapContents(messages) {
    const contents = [];
    const push = (role, parts) => {
        if (!parts.length)
            return;
        const last = contents.at(-1);
        // Function responses for one model turn must be grouped in a single content entry.
        if (last && last.role === role)
            last.parts.push(...parts);
        else
            contents.push({ role, parts });
    };
    for (const message of messages) {
        if (message.role === "system")
            continue;
        if (message.role === "tool") {
            push("user", [{ functionResponse: {
                        ...(message.toolCallId ? { id: message.toolCallId } : {}),
                        name: message.toolName ?? "tool",
                        response: message.isError ? { error: message.content } : { output: message.content },
                    } }]);
            continue;
        }
        const parts = [];
        if (message.content)
            parts.push({ text: message.content });
        for (const call of message.toolCalls ?? []) {
            parts.push({
                functionCall: { id: call.id, name: call.name, args: call.arguments },
                ...(typeof call.providerMeta?.thoughtSignature === "string" ? { thoughtSignature: call.providerMeta.thoughtSignature } : {}),
            });
        }
        if (!parts.length)
            parts.push({ text: message.role === "assistant" ? "(empty response)" : "(empty message)" });
        push(message.role === "assistant" ? "model" : "user", parts);
    }
    if (contents[0]?.role === "model")
        contents.unshift({ role: "user", parts: [{ text: "(continuing the session summarized above)" }] });
    return contents;
}
function usageFrom(raw) {
    if (!raw)
        return undefined;
    const thoughts = typeof raw.thoughtsTokenCount === "number" ? raw.thoughtsTokenCount : 0;
    return {
        ...(typeof raw.promptTokenCount === "number" ? { inputTokens: raw.promptTokenCount } : {}),
        ...(typeof raw.candidatesTokenCount === "number" ? { outputTokens: raw.candidatesTokenCount + thoughts } : {}),
        ...(typeof raw.cachedContentTokenCount === "number" ? { cachedInputTokens: raw.cachedContentTokenCount } : {}),
        ...(thoughts ? { reasoningTokens: thoughts } : {}),
    };
}
function blocked(data) {
    const reason = data.promptFeedback?.blockReason;
    if (reason)
        return new ProviderError(`Gemini blocked the prompt (${reason}).`, undefined, undefined, "bad_request");
    return undefined;
}
export class GeminiAdapter {
    id;
    baseUrl;
    config;
    constructor(id, config) {
        this.id = id;
        this.config = config;
        this.baseUrl = config.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
    }
    async complete(request) {
        const apiKey = requireApiKey(this.id, this.config.apiKeyEnv ?? "GEMINI_API_KEY");
        const model = request.model.replace(/^models\//, "");
        const system = request.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
        const stream = Boolean(request.onDelta) && this.config.stream !== false;
        const body = {
            contents: mapContents(request.messages),
            ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
            ...(request.tools.length ? {
                tools: [{ functionDeclarations: request.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: sanitizeSchema(tool.parameters) })) }],
            } : {}),
            generationConfig: {
                ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
                ...(request.maxTokens !== undefined ? { maxOutputTokens: request.maxTokens } : {}),
            },
            ...this.config.options,
            ...request.options,
        };
        const init = {
            method: "POST",
            headers: { "content-type": "application/json", "x-goog-api-key": apiKey ?? "", ...this.config.headers },
            body: JSON.stringify(body),
        };
        const options = { timeoutMs: this.config.timeoutMs ?? 300_000, ...(request.signal ? { signal: request.signal } : {}) };
        const path = `models/${encodeURIComponent(model)}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
        const url = joinUrl(this.baseUrl, path);
        const state = { content: "", calls: [] };
        const absorb = (data) => {
            const error = blocked(data);
            if (error)
                throw error;
            const usage = usageFrom(data.usageMetadata);
            if (usage)
                state.usage = usage;
            const candidate = data.candidates?.[0];
            if (!candidate)
                return;
            if (candidate.finishReason)
                state.finishReason = candidate.finishReason;
            for (const part of candidate.content?.parts ?? []) {
                if (typeof part.text === "string") {
                    if (part.thought === true)
                        request.onDelta?.({ type: "reasoning", text: part.text });
                    else {
                        state.content += part.text;
                        request.onDelta?.({ type: "text", text: part.text });
                    }
                }
                if (part.functionCall) {
                    const call = {
                        id: typeof part.functionCall.id === "string" ? part.functionCall.id : "",
                        name: part.functionCall.name,
                        arguments: part.functionCall.args ?? {},
                        ...(typeof part.thoughtSignature === "string" ? { providerMeta: { thoughtSignature: part.thoughtSignature } } : {}),
                    };
                    state.calls.push(call);
                    request.onDelta?.({ type: "tool-call", id: call.id, name: call.name });
                }
            }
        };
        if (stream) {
            await streamRequest(url, init, options, async (response) => {
                for await (const event of sse(response))
                    absorb(parseJson(event.data));
            });
        }
        else {
            absorb(await fetchJson(url, init, options));
        }
        if (!state.content && !state.calls.length) {
            if (state.finishReason === "MALFORMED_FUNCTION_CALL") {
                throw new ProviderError("Gemini produced a malformed function call.", undefined, undefined, "malformed");
            }
            if (state.finishReason && /SAFETY|RECITATION|BLOCKLIST|PROHIBITED/.test(state.finishReason)) {
                throw new ProviderError(`Gemini stopped generation (${state.finishReason}).`, undefined, undefined, "bad_request");
            }
        }
        return {
            content: state.content,
            toolCalls: uniqueCallIds(state.calls),
            ...(state.finishReason ? { finishReason: state.finishReason } : {}),
            ...(state.usage ? { usage: state.usage } : {}),
        };
    }
    async listModels() {
        const apiKey = requireApiKey(this.id, this.config.apiKeyEnv ?? "GEMINI_API_KEY");
        const data = await fetchJson(joinUrl(this.baseUrl, "models"), { headers: { "x-goog-api-key": apiKey ?? "", ...this.config.headers } }, 30_000);
        return (data.models ?? []).map((model) => String(model.name).replace(/^models\//, "")).sort();
    }
}
//# sourceMappingURL=gemini.js.map