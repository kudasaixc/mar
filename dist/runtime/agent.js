import { ContextManager } from "../context/manager.js";
import { TaskState } from "../context/task-state.js";
import { estimateText } from "../context/tokens.js";
import { BudgetExceededError, CancelledError, ContextOverflowError, MarError, ProviderError, errorMessage, isCancellation } from "../errors.js";
import { resolveCapabilities } from "../providers/capabilities.js";
import { withRetry } from "../providers/retry.js";
import { oneLine } from "../util/text.js";
export const DEFAULT_AGENT_SETTINGS = {
    context: { compactAt: 0.8, targetAfterCompaction: 0.5, keepRecentTurns: 4, maxToolResultChars: 2_000, summarizer: "model" },
    retry: { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 30_000 },
    stream: true,
};
/** Identical failing calls allowed before MAR refuses to repeat them. */
const MAX_IDENTICAL_FAILURES = 3;
/**
 * One agent's tool loop. Every provider request goes through context
 * management, retry with backoff, and the fallback chain; tool calls are only
 * executed from a complete response, never inside a retry, so side effects are
 * not replayed.
 */
export class AgentRuntime {
    profile;
    taskState;
    context;
    providers;
    tools;
    onEvent;
    settings;
    capabilities;
    messages;
    failures = new Map();
    options;
    running = false;
    constructor(options) {
        this.options = options;
        this.profile = options.profile;
        this.providers = options.providers;
        this.tools = options.tools;
        this.onEvent = options.onEvent;
        this.settings = options.settings ?? DEFAULT_AGENT_SETTINGS;
        this.taskState = options.taskState ?? new TaskState();
        this.capabilities = this.capabilitiesOf(this.profile.provider, this.profile.model, this.profile.capabilities);
        const maxOutput = this.profile.maxTokens ?? this.capabilities.maxOutputTokens;
        const contextSettings = this.profile.compactAt !== undefined ? { ...this.settings.context, compactAt: this.profile.compactAt } : this.settings.context;
        this.context = new ContextManager(contextSettings, this.capabilities, maxOutput);
        this.messages = [{ role: "system", content: systemPrompt(options) }];
    }
    get name() {
        return this.profile.name;
    }
    get busy() {
        return this.running;
    }
    /** Compatibility API: the final text, or a thrown error when the run did not complete. */
    async run(input, signal) {
        const result = await this.runDetailed(input, signal);
        if (result.status === "completed")
            return result.output;
        if (result.status === "cancelled")
            throw new CancelledError(result.output);
        if (result.status === "budget_exceeded")
            throw new BudgetExceededError(result.output);
        throw new MarError(result.output);
    }
    async runDetailed(input, signal) {
        if (this.running)
            throw new MarError(`Agent "${this.name}" is already running.`);
        this.running = true;
        const maxTurns = this.profile.maxTurns ?? 30;
        let turns = 0;
        this.onEvent({ type: "agent:start", agent: this.name, model: `${this.profile.provider}/${this.profile.model}` });
        const finish = (status, output, error) => {
            this.running = false;
            this.onEvent({ type: "agent:end", agent: this.name, turns, status });
            return {
                status, output, turns, verification: this.taskState.verification(), modifiedFiles: [...this.taskState.modifiedFiles],
                ...(error ? { error } : {}),
            };
        };
        try {
            this.taskState.addInstruction(input);
            this.push({ role: "user", content: input });
            for (turns = 1; turns <= maxTurns; turns += 1) {
                if (signal?.aborted)
                    throw new CancelledError();
                this.options.usage?.checkBudget();
                const response = await this.complete(signal);
                const assistant = { role: "assistant", content: response.content };
                if (response.toolCalls.length)
                    assistant.toolCalls = response.toolCalls;
                if (response.reasoning?.length)
                    assistant.reasoning = response.reasoning;
                this.push(assistant);
                if (response.content)
                    this.onEvent({ type: "agent:text", agent: this.name, text: response.content, streamed: response.streamed });
                if (!response.toolCalls.length)
                    return finish("completed", response.content);
                await this.executeTools(response.toolCalls, signal);
            }
            turns = maxTurns;
            return finish("max_turns", `Agent "${this.name}" reached its ${maxTurns}-turn limit before finishing. ${this.taskState.verification().detail}`);
        }
        catch (error) {
            if (isCancellation(error, signal))
                return finish("cancelled", "Cancelled by the user.");
            if (error instanceof BudgetExceededError)
                return finish("budget_exceeded", error.message, error.message);
            return finish("failed", `Agent "${this.name}" failed: ${errorMessage(error)}`, errorMessage(error));
        }
        finally {
            this.running = false;
        }
    }
    reset() {
        this.messages.splice(1);
        this.failures.clear();
        this.context.accountant.invalidate();
    }
    history() {
        return this.messages;
    }
    /** Replace the conversation with a recovered one (keeps the current system prompt). */
    restore(messages) {
        const rest = messages.filter((message, index) => !(index === 0 && message.role === "system" && !message.meta?.summary));
        this.messages.splice(1, this.messages.length - 1, ...rest);
        this.context.restore(this.messages);
    }
    contextUsage() {
        return this.context.usage(this.messages, this.tools.specs());
    }
    /** Force a compaction now (the /compact command). */
    async compact(signal) {
        return this.runCompaction(true, signal);
    }
    /** Embedders may pass a minimal registry exposing only get(); fall back to conservative defaults. */
    capabilitiesOf(provider, model, override) {
        if (typeof this.providers.capabilities === "function")
            return this.providers.capabilities(provider, model, override);
        const adapter = this.providers.get(provider);
        return resolveCapabilities("plugin", model, adapter.capabilities?.(model), override);
    }
    push(message) {
        this.messages.push(message);
        this.options.journal?.("message", message);
    }
    async runCompaction(force, signal) {
        const tools = this.tools.specs();
        const report = await this.context.compact(this.messages, tools, this.taskState, {
            force,
            ...(this.settings.context.summarizer === "model" ? { summarizer: this.summarizer() } : {}),
            ...(signal ? { signal } : {}),
        });
        if (report.compacted) {
            this.onEvent({ type: "agent:compaction", agent: this.name, beforeTokens: report.beforeTokens, afterTokens: report.afterTokens, strategy: report.strategy });
            this.options.journal?.("compaction", { messages: this.messages, report });
        }
        for (const warning of report.warnings)
            this.onEvent({ type: "agent:warning", agent: this.name, message: warning });
        return report;
    }
    summarizer() {
        return async (digest, signal) => {
            const adapter = this.providers.get(this.profile.provider);
            const response = await adapter.complete({
                model: this.profile.model,
                messages: [
                    { role: "system", content: "You summarize a coding agent's earlier work so it can continue after its context is trimmed. Be factual and concise (under 400 words). Keep file paths, commands, results, errors, and open problems. Do not invent anything." },
                    { role: "user", content: digest },
                ],
                tools: [],
                maxTokens: 1_024,
                ...(signal ? { signal } : {}),
            });
            this.options.usage?.record(this.name, `${this.profile.provider}/${this.profile.model}`, response.usage, { input: estimateText(digest), output: estimateText(response.content) });
            return response.content;
        };
    }
    /** One model response with compaction, overflow recovery, retry, and fallback. */
    async complete(signal) {
        if (this.context.needsCompaction(this.messages, this.tools.specs()))
            await this.runCompaction(false, signal);
        try {
            return await this.completeWithFallback(signal);
        }
        catch (error) {
            if (!(error instanceof ProviderError && error.kind === "context_overflow"))
                throw error;
            // The estimate was too low: calibrate upward, compact hard, and try once more.
            this.context.accountant.penalize();
            this.onEvent({ type: "agent:warning", agent: this.name, message: `Provider reported context overflow; compacting and retrying. (${oneLine(error.message, 160)})` });
            await this.runCompaction(true, signal);
            try {
                return await this.completeWithFallback(signal);
            }
            catch (retryError) {
                if (retryError instanceof ProviderError && retryError.kind === "context_overflow") {
                    throw new ContextOverflowError(`The conversation does not fit the model's context even after compaction: ${retryError.message}`);
                }
                throw retryError;
            }
        }
    }
    async completeWithFallback(signal) {
        const candidates = [{ provider: this.profile.provider, model: this.profile.model }, ...(this.profile.fallbacks ?? [])];
        const tools = this.tools.specs();
        let lastError;
        for (const [index, candidate] of candidates.entries()) {
            const label = `${candidate.provider}/${candidate.model}`;
            try {
                const adapter = this.providers.get(candidate.provider);
                const capabilities = index === 0 ? this.capabilities : this.capabilitiesOf(candidate.provider, candidate.model);
                const stream = this.settings.stream && capabilities.streaming && (typeof this.providers.streams !== "function" || this.providers.streams(candidate.provider));
                const estimate = this.context.accountant.estimate(this.messages, tools).tokens;
                let streamed = false;
                const response = await withRetry(async () => {
                    const request = {
                        model: candidate.model,
                        messages: this.messages,
                        tools,
                        contextWindow: capabilities.contextWindow,
                        ...(this.profile.temperature !== undefined ? { temperature: this.profile.temperature } : {}),
                        ...(this.profile.maxTokens !== undefined ? { maxTokens: this.profile.maxTokens } : {}),
                        ...(this.profile.options ? { options: this.profile.options } : {}),
                        ...(signal ? { signal } : {}),
                        ...(stream ? {
                            onDelta: (delta) => {
                                if (delta.type === "text") {
                                    streamed = true;
                                    this.onEvent({ type: "agent:delta", agent: this.name, text: delta.text });
                                }
                                else if (delta.type === "reasoning")
                                    this.onEvent({ type: "agent:reasoning", agent: this.name, text: delta.text });
                                else if (delta.type === "reset")
                                    this.onEvent({ type: "agent:stream-reset", agent: this.name });
                            },
                        } : {}),
                    };
                    return adapter.complete(request);
                }, this.settings.retry, signal, (notice) => {
                    if (streamed)
                        this.onEvent({ type: "agent:stream-reset", agent: this.name });
                    streamed = false;
                    this.onEvent({ type: "agent:retry", agent: this.name, model: label, attempt: notice.attempt, delayMs: notice.delayMs, error: oneLine(notice.error.message, 200) });
                });
                this.recordUsage(label, response, estimate);
                return { ...response, streamed };
            }
            catch (error) {
                if (isCancellation(error, signal))
                    throw error instanceof CancelledError ? error : new CancelledError();
                if (error instanceof ProviderError && error.kind === "context_overflow")
                    throw error;
                lastError = error;
                if (index < candidates.length - 1) {
                    this.onEvent({ type: "agent:fallback", agent: this.name, model: label, error: oneLine(errorMessage(error), 300) });
                }
            }
        }
        throw lastError instanceof Error ? lastError : new MarError(String(lastError));
    }
    recordUsage(model, response, estimate) {
        this.context.accountant.observe(response.usage?.inputTokens, this.messages, estimate);
        const output = estimateText(response.content) + estimateText(JSON.stringify(response.toolCalls));
        this.options.usage?.record(this.name, model, response.usage, { input: estimate, output });
        const usage = this.context.usage(this.messages, this.tools.specs());
        this.onEvent({
            type: "agent:usage", agent: this.name,
            inputTokens: response.usage?.inputTokens ?? estimate, outputTokens: response.usage?.outputTokens ?? output,
            contextTokens: usage.tokens, contextWindow: usage.window,
        });
    }
    /**
     * Read-only tools and delegations run concurrently; anything that may write or
     * execute runs sequentially in the order the model emitted it.
     */
    async executeTools(calls, signal) {
        const concurrent = calls.length > 1 && calls.every((call) => call.name === "delegate" || this.tools.permissionOf(call.name) === "read");
        const results = new Map();
        if (concurrent) {
            await Promise.all(calls.map(async (call) => results.set(call.id, await this.executeTool(call, signal))));
        }
        else {
            for (const call of calls) {
                if (signal?.aborted)
                    break;
                results.set(call.id, await this.executeTool(call, signal));
            }
        }
        // Every call gets exactly one result, in order, so the history stays valid for every provider.
        for (const call of calls) {
            this.push(results.get(call.id) ?? {
                role: "tool", toolCallId: call.id, toolName: call.name, isError: true,
                content: "NOT EXECUTED: the run was cancelled before this tool call started.", meta: { synthetic: "not-started" },
            });
        }
        if (signal?.aborted)
            throw new CancelledError();
    }
    async executeTool(call, signal) {
        const key = `${call.name}:${stableJson(call.arguments)}`;
        const started = Date.now();
        this.onEvent({ type: "agent:tool", agent: this.name, tool: call.name, detail: oneLine(JSON.stringify(call.arguments), 300), callId: call.id });
        let result;
        if ((this.failures.get(key) ?? 0) >= MAX_IDENTICAL_FAILURES) {
            result = { ok: false, output: `Refused: this exact ${call.name} call already failed ${MAX_IDENTICAL_FAILURES} times. Change the arguments or the approach instead of repeating it.` };
            this.onEvent({ type: "agent:warning", agent: this.name, message: `Blocked a repeated failing ${call.name} call.` });
        }
        else {
            this.options.journal?.("tool:start", { callId: call.id, name: call.name });
            result = await this.tools.execute(call.name, call.arguments, { agent: this.name, callId: call.id, ...(signal ? { signal } : {}) });
            this.options.journal?.("tool:end", { callId: call.id, name: call.name, ok: result.ok, meta: result.meta });
            if (result.ok)
                this.failures.delete(key);
            else
                this.failures.set(key, (this.failures.get(key) ?? 0) + 1);
            this.taskState.recordToolResult(call.name, key, result, this.tools.isMutating(call.name));
        }
        const durationMs = Date.now() - started;
        this.onEvent({ type: "agent:tool-result", agent: this.name, tool: call.name, ok: result.ok, preview: oneLine(result.output, 300), callId: call.id, durationMs });
        return {
            role: "tool",
            content: result.output || (result.ok ? "(no output)" : "(failed without output)"),
            toolCallId: call.id,
            toolName: call.name,
            ...(result.ok ? {} : { isError: true }),
            ...(result.meta?.cancelled ? { meta: { synthetic: "cancelled" } } : {}),
        };
    }
}
function stableJson(value) {
    if (Array.isArray(value))
        return `[${value.map(stableJson).join(",")}]`;
    if (value && typeof value === "object") {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
}
function systemPrompt(options) {
    return `You are ${options.profile.name}, ${options.profile.description}

You are an autonomous coding agent operating inside this workspace:
${options.workspace}

${options.teamContext}

Operating rules:
- Inspect before editing. Read a file before changing it; make the smallest coherent change that completes the task.
- Use workspace-relative paths only. Access outside the workspace is refused.
- Prefer edit_file or apply_patch for changes; prefer run_command with argv (no shell).
- Record a plan with update_plan for multi-step work; it survives context compaction.
- Verify with real checks (tests, type checks, linters) after changing code. Never claim a check passed unless you ran it in this session and saw it pass. If you could not verify, say so.
- Tool failures are reported as errors: read them, do not repeat an identical failing call.
- Do not expose secrets, environment values, or credentials in output or files.
- Finish with a concise factual handoff: what changed, what was verified (with the command), and what remains.

${options.profile.systemPrompt ?? ""}`.trim();
}
//# sourceMappingURL=agent.js.map