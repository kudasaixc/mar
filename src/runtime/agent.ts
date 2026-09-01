import type { AgentProfile, ChatMessage, CompletionRequest, ModelAdapter, RuntimeEventHandler, ToolCall } from "../types.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { ToolRegistry } from "../tools/registry.js";

export interface AgentRuntimeOptions {
  profile: AgentProfile;
  providers: ProviderRegistry;
  tools: ToolRegistry;
  workspace: string;
  teamContext: string;
  onEvent: RuntimeEventHandler;
}

export class AgentRuntime {
  readonly profile: AgentProfile;
  private readonly providers: ProviderRegistry;
  private readonly tools: ToolRegistry;
  private readonly onEvent: RuntimeEventHandler;
  private readonly messages: ChatMessage[];

  constructor(options: AgentRuntimeOptions) {
    this.profile = options.profile;
    this.providers = options.providers;
    this.tools = options.tools;
    this.onEvent = options.onEvent;
    this.messages = [{ role: "system", content: systemPrompt(options) }];
  }

  async run(input: string): Promise<string> {
    this.messages.push({ role: "user", content: input });
    const maxTurns = this.profile.maxTurns ?? 30;
    this.onEvent({ type: "agent:start", agent: this.profile.name, model: `${this.profile.provider}/${this.profile.model}` });

    for (let turn = 1; turn <= maxTurns; turn += 1) {
      const response = await this.completeWithFallback();
      const assistant: ChatMessage = { role: "assistant", content: response.content };
      if (response.toolCalls.length) assistant.toolCalls = response.toolCalls;
      this.messages.push(assistant);

      if (response.content) this.onEvent({ type: "agent:text", agent: this.profile.name, text: response.content });
      if (!response.toolCalls.length) {
        this.onEvent({ type: "agent:end", agent: this.profile.name, turns: turn });
        return response.content;
      }

      const results = response.toolCalls.every((call) => call.name === "delegate")
        ? await Promise.all(response.toolCalls.map((call) => this.executeTool(call)))
        : await this.executeSequentially(response.toolCalls);
      this.messages.push(...results);
    }
    throw new Error(`Agent "${this.profile.name}" reached its ${maxTurns}-turn limit.`);
  }

  reset(): void {
    this.messages.splice(1);
  }

  history(): readonly ChatMessage[] {
    return this.messages;
  }

  private async executeSequentially(calls: ToolCall[]): Promise<ChatMessage[]> {
    const messages: ChatMessage[] = [];
    for (const call of calls) messages.push(await this.executeTool(call));
    return messages;
  }

  private async executeTool(call: ToolCall): Promise<ChatMessage> {
    const detail = JSON.stringify(call.arguments).slice(0, 300);
    this.onEvent({ type: "agent:tool", agent: this.profile.name, tool: call.name, detail });
    const result = await this.tools.execute(call.name, call.arguments, { agent: this.profile.name });
    this.onEvent({
      type: "agent:tool-result",
      agent: this.profile.name,
      tool: call.name,
      ok: result.ok,
      preview: result.output.slice(0, 300),
    });
    return {
      role: "tool",
      content: JSON.stringify({ ok: result.ok, output: result.output }),
      toolCallId: call.id,
      toolName: call.name,
    };
  }

  private async completeWithFallback() {
    const candidates = [
      { provider: this.profile.provider, model: this.profile.model },
      ...(this.profile.fallbacks ?? []),
    ];
    let lastError: unknown;
    for (const candidate of candidates) {
      try {
        const adapter: ModelAdapter = this.providers.get(candidate.provider);
        const request: CompletionRequest = {
          model: candidate.model,
          messages: this.messages,
          tools: this.tools.specs(),
          ...(this.profile.temperature !== undefined ? { temperature: this.profile.temperature } : {}),
          ...(this.profile.maxTokens !== undefined ? { maxTokens: this.profile.maxTokens } : {}),
          ...(this.profile.options ? { options: this.profile.options } : {}),
        };
        return await adapter.complete(request);
      } catch (error) {
        lastError = error;
        if (candidate !== candidates.at(-1)) {
          this.onEvent({
            type: "agent:fallback",
            agent: this.profile.name,
            model: `${candidate.provider}/${candidate.model}`,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

function systemPrompt(options: AgentRuntimeOptions): string {
  return `You are ${options.profile.name}, ${options.profile.description}

You are an autonomous coding agent operating inside this shared workspace:
${options.workspace}

${options.teamContext}

Operating rules:
- Inspect before editing. Make the smallest coherent change that completes the task.
- Use workspace-relative paths only. Never attempt to access files outside the workspace.
- Use tools to verify assumptions, edit files, run focused checks, and inspect the final diff.
- Do not claim a command passed unless you ran it and saw the result.
- Coordinate through delegation and shared notes when another agent is better suited.
- Do not expose secrets, environment values, or credentials in output or files.
- Stop when the requested outcome is complete and return a concise factual handoff.

${options.profile.systemPrompt ?? ""}`.trim();
}
