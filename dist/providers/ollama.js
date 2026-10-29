import { ProviderError } from "../errors.js";
import { fetchJson, joinUrl, ndjson, parseArguments, streamRequest, uniqueCallIds } from "./http.js";
function mapMessage(message) {
    if (message.role === "tool") {
        return { role: "tool", content: message.isError ? `[tool error]\n${message.content}` : message.content, tool_name: message.toolName };
    }
    return {
        role: message.role,
        content: message.content,
        ...(message.toolCalls?.length ? {
            tool_calls: message.toolCalls.map((call) => ({
                type: "function",
                function: { name: call.name, arguments: call.arguments },
            })),
        } : {}),
    };
}
function usageFrom(data) {
    return {
        ...(typeof data.prompt_eval_count === "number" ? { inputTokens: data.prompt_eval_count } : {}),
        ...(typeof data.eval_count === "number" ? { outputTokens: data.eval_count } : {}),
    };
}
function toolCalls(raw) {
    return raw.map((call) => ({
        id: typeof call.id === "string" ? call.id : "",
        name: call.function?.name ?? "unknown",
        arguments: parseArguments(call.function?.arguments),
    }));
}
export class OllamaAdapter {
    id;
    baseUrl;
    config;
    constructor(id, config) {
        this.id = id;
        this.config = config;
        this.baseUrl = config.baseUrl ?? "http://localhost:11434";
    }
    async complete(request) {
        const stream = Boolean(request.onDelta) && this.config.stream !== false;
        const options = {
            ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
            ...(request.maxTokens !== undefined ? { num_predict: request.maxTokens } : {}),
            // Ollama silently truncates prompts longer than num_ctx; declare the window MAR budgets for.
            ...(request.contextWindow !== undefined ? { num_ctx: request.contextWindow } : {}),
            ...this.config.options,
            ...request.options,
        };
        const init = {
            method: "POST",
            headers: { "content-type": "application/json", ...this.config.headers },
            body: JSON.stringify({
                model: request.model,
                messages: request.messages.map(mapMessage),
                stream,
                ...(request.tools.length ? { tools: request.tools.map((tool) => ({ type: "function", function: tool })) } : {}),
                options,
            }),
        };
        const url = joinUrl(this.baseUrl, "api/chat");
        const requestOptions = { timeoutMs: this.config.timeoutMs ?? 600_000, ...(request.signal ? { signal: request.signal } : {}) };
        if (!stream) {
            const data = await fetchJson(url, init, requestOptions);
            if (data.error)
                throw new ProviderError(`Ollama error: ${String(data.error)}`, undefined, undefined, "server");
            return {
                content: data.message?.content ?? "",
                toolCalls: uniqueCallIds(toolCalls(data.message?.tool_calls ?? []), "ollama"),
                finishReason: data.done_reason,
                usage: usageFrom(data),
            };
        }
        return streamRequest(url, init, requestOptions, async (response) => {
            let content = "";
            const calls = [];
            let finishReason;
            let usage = {};
            for await (const chunk of ndjson(response)) {
                if (chunk.error)
                    throw new ProviderError(`Ollama stream error: ${String(chunk.error)}`, undefined, undefined, "server");
                const message = chunk.message ?? {};
                if (typeof message.thinking === "string" && message.thinking)
                    request.onDelta?.({ type: "reasoning", text: message.thinking });
                if (typeof message.content === "string" && message.content) {
                    content += message.content;
                    request.onDelta?.({ type: "text", text: message.content });
                }
                if (Array.isArray(message.tool_calls)) {
                    for (const call of toolCalls(message.tool_calls)) {
                        calls.push(call);
                        request.onDelta?.({ type: "tool-call", id: call.id, name: call.name });
                    }
                }
                if (chunk.done) {
                    finishReason = chunk.done_reason;
                    usage = usageFrom(chunk);
                }
            }
            return { content, toolCalls: uniqueCallIds(calls, "ollama"), ...(finishReason ? { finishReason } : {}), usage };
        });
    }
    async listModels() {
        const data = await fetchJson(joinUrl(this.baseUrl, "api/tags"), {}, 10_000);
        return (data.models ?? []).map((model) => String(model.name)).sort();
    }
}
//# sourceMappingURL=ollama.js.map