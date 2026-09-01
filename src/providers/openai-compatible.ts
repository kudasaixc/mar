import type { ChatMessage, CompletionRequest, CompletionResponse, ModelAdapter, ProviderConfig } from "../types.js";
import { contentToString, fetchJson, joinUrl, parseArguments, requireApiKey } from "./http.js";

function mapMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return { role: "tool", content: message.content, tool_call_id: message.toolCallId };
  }
  const mapped: Record<string, unknown> = { role: message.role, content: message.content || null };
  if (message.toolCalls?.length) {
    mapped.tool_calls = message.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    }));
  }
  return mapped;
}

export class OpenAICompatibleAdapter implements ModelAdapter {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly config: ProviderConfig;

  constructor(id: string, config: ProviderConfig) {
    this.id = id;
    this.config = config;
    this.baseUrl = config.baseUrl ?? "https://api.openai.com/v1";
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const apiKey = requireApiKey(this.id, this.config.apiKeyEnv);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      ...this.config.headers,
    };
    const body: Record<string, unknown> = {
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
    if (!choice?.message) throw new Error(`Provider "${this.id}" returned no completion choice.`);
    return {
      content: contentToString(choice.message.content),
      toolCalls: (choice.message.tool_calls ?? []).map((call: any, index: number) => ({
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

  async listModels(): Promise<string[]> {
    const apiKey = requireApiKey(this.id, this.config.apiKeyEnv);
    const data = await fetchJson(joinUrl(this.baseUrl, "models"), {
      headers: {
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        ...this.config.headers,
      },
    }, 30_000);
    return (data.data ?? []).map((model: any) => String(model.id)).sort();
  }
}
