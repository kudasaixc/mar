import type { ChatMessage, CompletionRequest, CompletionResponse, ModelAdapter, ProviderConfig } from "../types.js";
import { fetchJson, joinUrl, requireApiKey } from "./http.js";

function mapMessage(message: ChatMessage): Record<string, unknown> | undefined {
  if (message.role === "system") return undefined;
  if (message.role === "tool") {
    return {
      role: "user",
      parts: [{ functionResponse: {
        id: message.toolCallId,
        name: message.toolName ?? "tool",
        response: { output: message.content },
      } }],
    };
  }
  const parts: Record<string, unknown>[] = [];
  if (message.content) parts.push({ text: message.content });
  if (message.toolCalls?.length) {
    parts.push(...message.toolCalls.map((call) => ({
      functionCall: { id: call.id, name: call.name, args: call.arguments },
    })));
  }
  return { role: message.role === "assistant" ? "model" : "user", parts };
}

export class GeminiAdapter implements ModelAdapter {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly config: ProviderConfig;

  constructor(id: string, config: ProviderConfig) {
    this.id = id;
    this.config = config;
    this.baseUrl = config.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const apiKey = requireApiKey(this.id, this.config.apiKeyEnv ?? "GEMINI_API_KEY");
    const model = request.model.replace(/^models\//, "");
    const system = request.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
    const contents = request.messages.map(mapMessage).filter((message): message is Record<string, unknown> => Boolean(message));
    const data = await fetchJson(joinUrl(this.baseUrl, `models/${encodeURIComponent(model)}:generateContent`), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey ?? "",
        ...this.config.headers,
      },
      body: JSON.stringify({
        contents,
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        ...(request.tools.length ? { tools: [{ functionDeclarations: request.tools }] } : {}),
        generationConfig: {
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          ...(request.maxTokens !== undefined ? { maxOutputTokens: request.maxTokens } : {}),
        },
        ...this.config.options,
        ...request.options,
      }),
    });
    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    return {
      content: parts.filter((part: any) => typeof part.text === "string").map((part: any) => part.text).join(""),
      toolCalls: parts.filter((part: any) => part.functionCall).map((part: any, index: number) => ({
        id: part.functionCall.id ?? `call_${Date.now()}_${index}`,
        name: part.functionCall.name,
        arguments: part.functionCall.args ?? {},
      })),
      finishReason: candidate?.finishReason,
      usage: {
        inputTokens: data.usageMetadata?.promptTokenCount,
        outputTokens: data.usageMetadata?.candidatesTokenCount,
      },
    };
  }
}
