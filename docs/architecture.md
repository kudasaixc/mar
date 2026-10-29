# Architecture

MAR keeps orchestration independent of model vendors and of the terminal UI. Everything below `cli.ts` is a library (`@kudasaixc/mar`) that emits typed `RuntimeEvent`s.

```
cli.ts ── ui/terminal.ts (Renderer, ApprovalPrompt)
   │
   ▼
runtime/orchestrator.ts ── orchestration/tasks.ts (TaskManager) ── orchestration/worktree.ts
   │                     └─ session/store.ts (journal, snapshots, lock)
   ▼
runtime/agent.ts (AgentRuntime: one conversation + tool loop)
   ├─ context/manager.ts (token accounting, compaction)   ├─ context/task-state.ts (plan, files, checks, failures)
   ├─ providers/registry.ts → adapters + retry.ts          └─ usage/tracker.ts (tokens, cost, budgets)
   ▼
tools/registry.ts (validation, SecurityPolicy, approval, audit)
   └─ tools/builtins.ts → tools/workspace.ts (path containment, FileLedger) → security/process.ts + security/sandbox.ts
```

## Run lifecycle

1. The CLI loads the global configuration, overlays the nearest `mar.config.json`, and migrates v1 documents in memory.
2. `Orchestrator.create` probes the sandbox backend (a hard error if it is unavailable), builds the workspace with its file ledger, the shared security policy, memory, usage tracker and checks, and restores state when resuming.
3. The master `AgentRuntime` receives the task. Before every request, the context manager compacts the history if it exceeds `context.compactAt` of the usable window.
4. Provider calls go through `withRetry` (backoff with jitter, `Retry-After`) and then the ordered fallback chain. A partially streamed response is discarded on retry (`agent:stream-reset`). Tool calls run only after a complete response, so a retry never replays a tool.
5. Tool calls run concurrently only when all of them are reads or delegations. Otherwise they run sequentially. Each call is validated against its JSON Schema, checked by the policy (deny, then read-only, then allow rules, then approval), journaled (`tool:start` and `tool:end`), and recorded in the task state.
6. On completion, the verification status is computed from tool evidence (files modified, checks run and their exit codes, unintegrated or conflicting tasks). It never comes from the model's own claims.

## Delegation

`delegate` creates a `TaskRecord` in the `TaskManager`, which enforces `maxWorkers` (a semaphore), `workerTimeoutMs`, `maxDelegations`, and dependencies (`depends_on` by task id or label, with cycle detection). Every task runs in a fresh `AgentRuntime` without the `delegate` tool, so there is no recursive delegation.

Isolation modes:

- **shared**: workers edit the main workspace directly. The file ledger refuses stale writes, so two workers editing the same file produce a reported conflict, not a silent overwrite.
- **worktree** (the default under `auto` in a Git repository): MAR snapshots the current working tree, including uncommitted and untracked files, into a commit using a temporary index. Your real index is untouched. It then creates a detached worktree under the state directory. The worker's changes are committed there. Integration runs `git apply --check` and then `git apply` on your working tree only, serialized by a mutex. On a conflict, the task becomes `conflict`, the worktree is kept for inspection, and nothing in your tree changes. The master can call `task_diff`, `integrate_task`, or `discard_task`.

The master is responsible for integration and verification. A run with an unintegrated or conflicting task reports `incomplete`.

## Sessions

`SessionStore` keeps one directory per session: `meta.json` (atomic), `journal.jsonl` (append-only), `snapshot.json` (atomic at turn boundaries, previous copy kept), and `lock` (the owning PID). On resume, MAR loads the latest valid snapshot, replays later journal messages, and repairs any tool call that has no result with a synthetic `INTERRUPTED — not re-executed` result. A session whose lock owner is dead is reported as `interrupted`.

## Stable boundaries

- `ModelAdapter`: normalizes provider messages, tool calls, streaming deltas, finish reasons, usage, and optional capability hints.
- `ToolDefinition`: declares a JSON Schema, a permission class, an optional command extractor (for rules and approval), and `execute(args, { agent, signal, callId })`.
- `AgentRuntime`, `Orchestrator`, `TaskManager`, `SessionStore`, `SecurityPolicy`, and `Redactor` are exported from `@kudasaixc/mar`. Plugin helpers come from `@kudasaixc/mar/plugin`.
