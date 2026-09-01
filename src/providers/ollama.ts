import type { ChatMessage, CompletionRequest, CompletionResponse, ModelAdapter, ProviderConfig } from "../types.js";
import { fetchJson, joinUrl } from "./http.js";

function mapMessage(message: ChatMessage): Record<string, unknown> {
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

export class OllamaAdapter implements ModelAdapter {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly config: ProviderConfig;

  constructor(id: string, config: ProviderConfig) {
    this.id = id;
    this.config = config;
    this.baseUrl = config.baseUrl ?? "http://localhost:11434";
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
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
      toolCalls: (data.message?.tool_calls ?? []).map((call: any, index: number) => ({
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

  async listModels(): Promise<string[]> {
    const data = await fetchJson(joinUrl(this.baseUrl, "api/tags"), {}, 10_000);
    return (data.models ?? []).map((model: any) => String(model.name)).sort();
  }
}
