# Architecture

MAR keeps orchestration independent from model vendors and terminal UI.

## Runtime flow

1. The CLI loads the global configuration and overlays the nearest `mar.config.json`.
2. The provider registry instantiates one adapter per configured provider.
3. The orchestrator creates one runtime per agent, separate conversation histories, a shared workspace, and a shared in-memory blackboard.
4. The master receives the user task and may call workspace tools or `delegate`.
5. Delegate calls in the same model response execute concurrently. Other tool calls execute sequentially to make local mutations predictable.
6. Workers act directly on the shared directory and return results to the master.
7. The master inspects the combined result, resolves issues, verifies it, and responds.

## Stable boundaries

- `ModelAdapter` normalizes provider messages, tool calls, finish reasons, and usage.
- `ToolDefinition` declares JSON Schema input, mutation status, and execution.
- `AgentRuntime` owns one conversation and its tool loop.
- `Orchestrator` wires the team together without provider-specific logic.
- `Workspace` enforces path containment, output limits, timeouts, and baseline command policy.
- `SessionStore` writes JSONL audit events under `~/.local/state/mar/sessions`.

The package exports the main runtime types from `@kudasaixc/mar` and plugin helpers from `@kudasaixc/mar/plugin`.

## Concurrency model

Workers share a filesystem, so the master should delegate disjoint files or responsibilities in parallel. MAR serializes each agent's non-delegation tool calls, writes files atomically, and checks every resolved path. It does not merge conflicting semantic edits automatically; final integration remains the master's responsibility.

## Future-compatible design

Provider-specific options may be set at provider or agent level. Unknown compatible endpoints can use `openai-compatible`; genuinely different protocols can implement `ModelAdapter` as a provider plugin. Tools can be added without modifying the orchestrator.
