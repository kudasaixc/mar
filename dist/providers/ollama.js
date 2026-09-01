import { fetchJson, joinUrl } from "./http.js";
function mapMessage(message) {
    if (message.role === "tool") {
        return { role: "tool", content: message.content, tool_name: message.toolName };
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
        const data = await fetchJson(joinUrl(this.baseUrl, "api/chat"), {
            method: "POST",
            headers: { "content-type": "application/json", ...this.config.headers },
            body: JSON.stringify({
                model: request.model,
                messages: request.messages.map(mapMessage),
                stream: false,
                ...(request.tools.length ? {
                    tools: request.tools.map((tool) => ({ type: "function", function: tool })),
                } : {}),
                options: {
                    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
                    ...(request.maxTokens !== undefined ? { num_predict: request.maxTokens } : {}),
                    ...this.config.options,
                    ...request.options,
                },
            }),
        });
        return {
            content: data.message?.content ?? "",
            toolCalls: (data.message?.tool_calls ?? []).map((call, index) => ({
                id: call.id ?? `ollama_${Date.now()}_${index}`,
                name: call.function?.name ?? "unknown",
                arguments: call.function?.arguments ?? {},
            })),
            finishReason: data.done_reason,
            usage: {
                inputTokens: data.prompt_eval_count,
                outputTokens: data.eval_count,
            },
        };
    }
    async listModels() {
        const data = await fetchJson(joinUrl(this.baseUrl, "api/tags"), {}, 10_000);
        return (data.models ?? []).map((model) => String(model.name)).sort();
    }
}
//# sourceMappingURL=ollama.js.map