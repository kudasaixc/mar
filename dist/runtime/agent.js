export class AgentRuntime {
    profile;
    providers;
    tools;
    onEvent;
    messages;
    constructor(options) {
        this.profile = options.profile;
        this.providers = options.providers;
        this.tools = options.tools;
        this.onEvent = options.onEvent;
        this.messages = [{ role: "system", content: systemPrompt(options) }];
    }
    async run(input) {
        this.messages.push({ role: "user", content: input });
        const maxTurns = this.profile.maxTurns ?? 30;
        this.onEvent({ type: "agent:start", agent: this.profile.name, model: `${this.profile.provider}/${this.profile.model}` });
        for (let turn = 1; turn <= maxTurns; turn += 1) {
            const response = await this.completeWithFallback();
            const assistant = { role: "assistant", content: response.content };
            if (response.toolCalls.length)
                assistant.toolCalls = response.toolCalls;
            this.messages.push(assistant);
            if (response.content)
                this.onEvent({ type: "agent:text", agent: this.profile.name, text: response.content });
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
    reset() {
        this.messages.splice(1);
    }
    history() {
        return this.messages;
    }
    async executeSequentially(calls) {
        const messages = [];
        for (const call of calls)
            messages.push(await this.executeTool(call));
        return messages;
    }
    async executeTool(call) {
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
    async completeWithFallback() {
        const candidates = [
            { provider: this.profile.provider, model: this.profile.model },
            ...(this.profile.fallbacks ?? []),
        ];
        let lastError;
        for (const candidate of candidates) {
            try {
                const adapter = this.providers.get(candidate.provider);
                const request = {
                    model: candidate.model,
                    messages: this.messages,
                    tools: this.tools.specs(),
                    ...(this.profile.temperature !== undefined ? { temperature: this.profile.temperature } : {}),
                    ...(this.profile.maxTokens !== undefined ? { maxTokens: this.profile.maxTokens } : {}),
                    ...(this.profile.options ? { options: this.profile.options } : {}),
                };
                return await adapter.complete(request);
            }
            catch (error) {
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
function systemPrompt(options) {
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
//# sourceMappingURL=agent.js.map