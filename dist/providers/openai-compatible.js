import { ProviderError } from "../errors.js";
import { contentToString, fetchJson, joinUrl, parseArguments, parseJson, requireApiKey, sse, streamRequest, uniqueCallIds } from "./http.js";
function mapMessage(message) {
    if (message.role === "tool") {
        return { role: "tool", content: message.isError ? `[tool error]\n${message.content}` : message.content, tool_call_id: message.toolCallId };
    }
    const mapped = { role: message.role, content: message.content || null };
    if (message.role !== "assistant" && !message.content)
        mapped.content = "";
    if (message.toolCalls?.length) {
        mapped.tool_calls = message.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        }));
    }
    return mapped;
}
function usageFrom(raw) {
    if (!raw)
        return undefined;
    return {
        ...(typeof raw.prompt_tokens === "number" ? { inputTokens: raw.prompt_tokens } : {}),
        ...(typeof raw.completion_tokens === "number" ? { outputTokens: raw.completion_tokens } : {}),
        ...(typeof raw.prompt_tokens_details?.cached_tokens === "number" ? { cachedInputTokens: raw.prompt_tokens_details.cached_tokens } : {}),
        ...(typeof raw.completion_tokens_details?.reasoning_tokens === "number" ? { reasoningTokens: raw.completion_tokens_details.reasoning_tokens } : {}),
    };
}
export class OpenAICompatibleAdapter {
    id;
    baseUrl;
    config;
    constructor(id, config) {
        this.id = id;
        this.config = config;
        this.baseUrl = config.baseUrl ?? "https://api.openai.com/v1";
    }
    get official() {
        return /api\.openai\.com/.test(this.baseUrl);
    }
    async complete(request) {
        const apiKey = requireApiKey(this.id, this.config.apiKeyEnv);
        const headers = {
            "content-type": "application/json",
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
            ...this.config.headers,
        };
        const stream = Boolean(request.onDelta) && this.config.stream !== false;
        const body = {
            model: request.model,
            messages: request.messages.map(mapMessage),
            stream,
            ...(stream && (this.official || /openrouter\.ai/.test(this.baseUrl)) ? { stream_options: { include_usage: true } } : {}),
            ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
            // OpenAI deprecated max_tokens for newer models; compatible servers still expect it.
            ...(request.maxTokens !== undefined ? { [this.official ? "max_completion_tokens" : "max_tokens"]: request.maxTokens } : {}),
            ...(request.tools.length ? {
                tools: request.tools.map((tool) => ({ type: "function", function: tool })),
                tool_choice: "auto",
            } : {}),
            ...this.config.options,
            ...request.options,
        };
        const url = joinUrl(this.baseUrl, "chat/completions");
        const init = { method: "POST", headers, body: JSON.stringify(body) };
        const options = { timeoutMs: this.config.timeoutMs ?? 180_000, ...(request.signal ? { signal: request.signal } : {}) };
        if (stream)
            return streamRequest(url, init, options, (response) => this.consume(response, request));
        return this.fromJson(await fetchJson(url, init, options));
    }
    fromJson(data) {
        if (data.error)
            throw new ProviderError(`Provider "${this.id}" error: ${JSON.stringify(data.error).slice(0, 300)}`, undefined, undefined, "server");
        const choice = data.choices?.[0];
        if (!choice?.message)
            throw new ProviderError(`Provider "${this.id}" returned no completion choice.`, undefined, undefined, "malformed");
        const usage = usageFrom(data.usage);
        return {
            content: contentToString(choice.message.content),
            toolCalls: uniqueCallIds((choice.message.tool_calls ?? []).map((call) => ({
                id: typeof call.id === "string" ? call.id : "",
                name: call.function?.name ?? "unknown",
                arguments: parseArguments(call.function?.arguments),
            }))),
            finishReason: choice.finish_reason,
            ...(usage ? { usage } : {}),
        };
    }
    async consume(response, request) {
        // Some compatible servers ignore `stream: true` and answer with a plain JSON body.
        if (/application\/json/i.test(response.headers.get("content-type") ?? "")) {
            const text = await response.text();
            const result = this.fromJson(parseJson(text));
            if (result.content)
                request.onDelta?.({ type: "text", text: result.content });
            return result;
        }
        let content = "";
        let finishReason;
        let usage;
        const calls = new Map();
        for await (const event of sse(response)) {
            if (event.data === "[DONE]")
                break;
            const chunk = parseJson(event.data);
            if (chunk.error) {
                const message = typeof chunk.error.message === "string" ? chunk.error.message : JSON.stringify(chunk.error);
                throw new ProviderError(`Provider "${this.id}" stream error: ${message}`, undefined, undefined, "server");
            }
            if (chunk.usage)
                usage = usageFrom(chunk.usage);
            const choice = chunk.choices?.[0];
            if (!choice)
                continue;
            if (choice.finish_reason)
                finishReason = choice.finish_reason;
            const delta = choice.delta ?? {};
            const reasoning = delta.reasoning_content ?? delta.reasoning;
            if (typeof reasoning === "string" && reasoning)
                request.onDelta?.({ type: "reasoning", text: reasoning });
            if (typeof delta.content === "string" && delta.content) {
                content += delta.content;
                request.onDelta?.({ type: "text", text: delta.content });
            }
            for (const part of delta.tool_calls ?? []) {
                const index = typeof part.index === "number" ? part.index : calls.size;
                let call = calls.get(index);
                if (!call) {
                    call = { id: "", name: "", args: "" };
                    calls.set(index, call);
                }
                if (typeof part.id === "string" && part.id)
                    call.id = part.id;
                if (typeof part.function?.name === "string" && part.function.name) {
                    call.name += part.function.name;
                    request.onDelta?.({ type: "tool-call", id: call.id, name: call.name });
                }
                if (typeof part.function?.arguments === "string")
                    call.args += part.function.arguments;
            }
        }
        const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b)
            .map(([, call]) => ({ id: call.id, name: call.name || "unknown", arguments: parseArguments(call.args) }));
        return { content, toolCalls: uniqueCallIds(toolCalls), ...(finishReason ? { finishReason } : {}), ...(usage ? { usage } : {}) };
    }
    async listModels() {
        const apiKey = requireApiKey(this.id, this.config.apiKeyEnv);
        const data = await fetchJson(joinUrl(this.baseUrl, "models"), {
            headers: {
                ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
                ...this.config.headers,
            },
        }, 30_000);
        return (data.data ?? []).map((model) => String(model.id)).sort();
    }
}
//# sourceMappingURL=openai-compatible.js.map