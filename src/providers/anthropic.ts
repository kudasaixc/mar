import type { ChatMessage, CompletionRequest, CompletionResponse, ModelAdapter, ProviderConfig } from "../types.js";
import { fetchJson, joinUrl, requireApiKey } from "./http.js";

function mapMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  let pendingTools: Record<string, unknown>[] = [];
  const flushTools = (): void => {
    if (pendingTools.length) {
      result.push({ role: "user", content: pendingTools });
      pendingTools = [];
    }
  };
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      pendingTools.push({ type: "tool_result", tool_use_id: message.toolCallId, content: message.content });
      continue;
    }
    flushTools();
    if (message.role === "assistant" && message.toolCalls?.length) {
      const content: Record<string, unknown>[] = [];
      if (message.content) content.push({ type: "text", text: message.content });
      content.push(...message.toolCalls.map((call) => ({
        type: "tool_use", id: call.id, name: call.name, input: call.arguments,
      })));
      result.push({ role: "assistant", content });
    } else {
      result.push({ role: message.role, content: message.content });
    }
  }
  flushTools();
  return result;
}

export class AnthropicAdapter implements ModelAdapter {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly config: ProviderConfig;

  constructor(id: string, config: ProviderConfig) {
    this.id = id;
    this.config = config;
    this.baseUrl = config.baseUrl ?? "https://api.anthropic.com/v1";
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const apiKey = requireApiKey(this.id, this.config.apiKeyEnv ?? "ANTHROPIC_API_KEY");
    const system = request.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
    const data = await fetchJson(joinUrl(this.baseUrl, "messages"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey ?? "",
        "anthropic-version": "2023-06-01",
        ...this.config.headers,
      },
      body: JSON.stringify({
        model: request.model,
        max_tokens: request.maxTokens ?? 8192,
        ...(system ? { system } : {}),
        messages: mapMessages(request.messages),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.tools.length ? {
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.parameters,
          })),
        } : {}),
        ...this.config.options,
        ...request.options,
      }),
    });
    const blocks = Array.isArray(data.content) ? data.content : [];
    return {
      content: blocks.filter((block: any) => block.type === "text").map((block: any) => block.text).join(""),
      toolCalls: blocks.filter((block: any) => block.type === "tool_use").map((block: any, index: number) => ({
        id: block.id ?? `call_${Date.now()}_${index}`,
        name: block.name,
        arguments: block.input ?? {},
      })),
      finishReason: data.stop_reason,
      usage: {
        inputTokens: data.usage?.input_tokens,
        outputTokens: data.usage?.output_tokens,
      },
    };
  }
}
