import { contentToString, fetchJson, joinUrl, parseArguments, requireApiKey } from "./http.js";
function mapMessage(message) {
    if (message.role === "tool") {
        return { role: "tool", content: message.content, tool_call_id: message.toolCallId };
    }
    const mapped = { role: message.role, content: message.content || null };
    if (message.toolCalls?.length) {
        mapped.tool_calls = message.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        }));
    }
    return mapped;
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
    async complete(request) {
        const apiKey = requireApiKey(this.id, this.config.apiKeyEnv);
        const headers = {
            "content-type": "application/json",
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
            ...this.config.headers,
        };
        const body = {
            model: request.model,
            messages: request.messages.map(mapMessage),
            stream: false,
            ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
            ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
            ...(request.tools.length ? {
                tools: request.tools.map((tool) => ({ type: "function", function: tool })),
                tool_choice: "auto",
            } : {}),
            ...this.config.options,
            ...request.options,
        };
        const data = await fetchJson(joinUrl(this.baseUrl, "chat/completions"), {
            method: "POST",
            headers,
            body: JSON.stringify(body),
        });
        const choice = data.choices?.[0];
        if (!choice?.message)
            throw new Error(`Provider "${this.id}" returned no completion choice.`);
        return {
            content: contentToString(choice.message.content),
            toolCalls: (choice.message.tool_calls ?? []).map((call, index) => ({
                id: call.id ?? `call_${Date.now()}_${index}`,
                name: call.function?.name ?? "unknown",
                arguments: parseArguments(call.function?.arguments),
            })),
            finishReason: choice.finish_reason,
            usage: {
                inputTokens: data.usage?.prompt_tokens,
                outputTokens: data.usage?.completion_tokens,
            },
        };
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