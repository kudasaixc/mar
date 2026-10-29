import { ProviderError } from "../errors.js";
import { fetchJson, joinUrl, parseArguments, parseJson, requireApiKey, sse, streamRequest, uniqueCallIds } from "./http.js";
export function mapMessages(messages, cache = false) {
    const result = [];
    const push = (role, blocks) => {
        const last = result.at(-1);
        // Anthropic requires alternating roles; merge consecutive messages of the same role.
        if (last && last.role === role)
            last.content.push(...blocks);
        else
            result.push({ role, content: blocks });
    };
    for (const message of messages) {
        if (message.role === "system")
            continue;
        if (message.role === "tool") {
            push("user", [{
                    type: "tool_result",
                    tool_use_id: message.toolCallId,
                    content: message.content || "(no output)",
                    ...(message.isError ? { is_error: true } : {}),
                }]);
            continue;
        }
        if (message.role === "assistant") {
            const blocks = [];
            for (const reasoning of message.reasoning ?? [])
                if (reasoning.provider === "anthropic")
                    blocks.push(reasoning.data);
            if (message.content)
                blocks.push({ type: "text", text: message.content });
            for (const call of message.toolCalls ?? [])
                blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments });
            if (!blocks.length)
                blocks.push({ type: "text", text: "(empty response)" });
            push("assistant", blocks);
            continue;
        }
        push("user", [{ type: "text", text: message.content || "(empty message)" }]);
    }
    // The Messages API requires the first message to be from the user (compaction can leave an assistant turn first).
    if (result[0]?.role === "assistant")
        result.unshift({ role: "user", content: [{ type: "text", text: "(continuing the session summarized above)" }] });
    if (cache) {
        const last = result.at(-1)?.content.at(-1);
        if (last)
            last.cache_control = { type: "ephemeral" };
    }
    return result;
}
function usageFrom(raw, previous = {}) {
    const input = raw?.input_tokens;
    const cacheRead = raw?.cache_read_input_tokens;
    const cacheWrite = raw?.cache_creation_input_tokens;
    const usage = { ...previous };
    if (typeof input === "number")
        usage.inputTokens = input + (typeof cacheRead === "number" ? cacheRead : 0) + (typeof cacheWrite === "number" ? cacheWrite : 0);
    if (typeof cacheRead === "number")
        usage.cachedInputTokens = cacheRead;
    if (typeof cacheWrite === "number")
        usage.cacheWriteTokens = cacheWrite;
    if (typeof raw?.output_tokens === "number")
        usage.outputTokens = raw.output_tokens;
    return usage;
}
export class AnthropicAdapter {
    id;
    baseUrl;
    config;
    constructor(id, config) {
        this.id = id;
        this.config = config;
        this.baseUrl = config.baseUrl ?? "https://api.anthropic.com/v1";
    }
    async complete(request) {
        const apiKey = requireApiKey(this.id, this.config.apiKeyEnv ?? "ANTHROPIC_API_KEY");
        const system = request.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
        const { promptCache, ...providerOptions } = { promptCache: true, ...this.config.options };
        const cache = promptCache !== false;
        const stream = Boolean(request.onDelta) && this.config.stream !== false;
        const tools = request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }));
        if (cache && tools.length)
            tools[tools.length - 1].cache_control = { type: "ephemeral" };
        const body = {
            model: request.model,
            max_tokens: request.maxTokens ?? 8192,
            ...(system ? { system: cache ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }] : system } : {}),
            messages: mapMessages(request.messages, cache),
            ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
            ...(tools.length ? { tools } : {}),
            ...(stream ? { stream: true } : {}),
            ...providerOptions,
            ...request.options,
        };
        const init = {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-api-key": apiKey ?? "",
                "anthropic-version": "2023-06-01",
                ...this.config.headers,
            },
            body: JSON.stringify(body),
        };
        const url = joinUrl(this.baseUrl, "messages");
        const options = { timeoutMs: this.config.timeoutMs ?? 300_000, ...(request.signal ? { signal: request.signal } : {}) };
        if (stream)
            return streamRequest(url, init, options, (response) => this.consume(response, request));
        const data = await fetchJson(url, init, options);
        if (data.type === "error")
            throw new ProviderError(`Anthropic error: ${data.error?.message ?? "unknown"}`, undefined, undefined, data.error?.type === "overloaded_error" ? "overloaded" : "server");
        const blocks = Array.isArray(data.content) ? data.content : [];
        const reasoning = blocks
            .filter((block) => block.type === "thinking" || block.type === "redacted_thinking")
            .map((block) => ({ provider: "anthropic", data: block }));
        return {
            content: blocks.filter((block) => block.type === "text").map((block) => block.text).join(""),
            toolCalls: uniqueCallIds(blocks.filter((block) => block.type === "tool_use").map((block) => ({
                id: typeof block.id === "string" ? block.id : "",
                name: block.name,
                arguments: block.input ?? {},
            }))),
            finishReason: data.stop_reason,
            usage: usageFrom(data.usage),
            ...(reasoning.length ? { reasoning } : {}),
        };
    }
    async consume(response, request) {
        const blocks = new Map();
        let usage = {};
        let finishReason;
        for await (const event of sse(response)) {
            const data = parseJson(event.data);
            switch (data.type) {
                case "message_start":
                    usage = usageFrom(data.message?.usage, usage);
                    break;
                case "content_block_start": {
                    const block = { ...data.content_block, _json: "" };
                    blocks.set(data.index, block);
                    if (block.type === "tool_use")
                        request.onDelta?.({ type: "tool-call", id: block.id, name: block.name });
                    break;
                }
                case "content_block_delta": {
                    const block = blocks.get(data.index);
                    if (!block)
                        break;
                    const delta = data.delta ?? {};
                    if (delta.type === "text_delta") {
                        block.text = (block.text ?? "") + delta.text;
                        request.onDelta?.({ type: "text", text: delta.text });
                    }
                    else if (delta.type === "input_json_delta")
                        block._json += delta.partial_json ?? "";
                    else if (delta.type === "thinking_delta") {
                        block.thinking = (block.thinking ?? "") + delta.thinking;
                        request.onDelta?.({ type: "reasoning", text: delta.thinking });
                    }
                    else if (delta.type === "signature_delta")
                        block.signature = (block.signature ?? "") + delta.signature;
                    break;
                }
                case "message_delta":
                    if (data.delta?.stop_reason)
                        finishReason = data.delta.stop_reason;
                    usage = usageFrom(data.usage, usage);
                    break;
                case "error": {
                    const type = data.error?.type;
                    throw new ProviderError(`Anthropic stream error: ${data.error?.message ?? "unknown"}`, undefined, undefined, type === "overloaded_error" ? "overloaded" : type === "rate_limit_error" ? "rate_limit" : "server");
                }
                default:
                    break;
            }
        }
        const ordered = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block);
        const toolCalls = ordered.filter((block) => block.type === "tool_use").map((block) => ({
            id: typeof block.id === "string" ? block.id : "",
            name: block.name,
            arguments: block._json ? parseArguments(block._json) : (block.input ?? {}),
        }));
        const reasoning = ordered
            .filter((block) => block.type === "thinking" || block.type === "redacted_thinking")
            .map(({ _json, ...block }) => ({ provider: "anthropic", data: block }));
        return {
            content: ordered.filter((block) => block.type === "text").map((block) => block.text ?? "").join(""),
            toolCalls: uniqueCallIds(toolCalls),
            ...(finishReason ? { finishReason } : {}),
            usage,
            ...(reasoning.length ? { reasoning } : {}),
        };
    }
}
//# sourceMappingURL=anthropic.js.map