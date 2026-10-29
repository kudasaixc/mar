# Changelog

All notable changes are documented here. MAR follows Semantic Versioning.

## 0.2.0 - unreleased

### Added

- **Persistent sessions.** Each run writes an append-only journal, atomic snapshots, and a process lock. New commands: `mar sessions [list|show|delete]` and `mar resume [id]`. Crash recovery repairs interrupted tool calls and never replays them. Sessions from 0.1.x are migrated on read.
- **Context management.** Usage is tracked per agent from provider-reported and estimated tokens. Compaction elides old tool output, then summarizes older turns with the model (or deterministically) while keeping the task, plan, and recent turns. A context-overflow error triggers one forced compaction and retry. New chat commands: `/context`, `/compact`.
- **Task state.** Each agent keeps a plan (`update_plan`), modified files, check results, and failure memory, which survives compaction and resume.
- **Honest verification.** Every run ends with `no_changes`, `unverified`, `checks_failed`, `tests_passing`, `confirmed`, or `incomplete`, derived from tool evidence and never from model claims. `--verify` runs configured or detected checks after the task. Exit code 2 signals failed checks.
- **Security.** Approval mode `auto-edit`; command allow and deny rules on parsed commands; environment scrubbing; secret redaction for terminal, journals, memory, and audit; a per-call audit trail; sandbox backends `bubblewrap` and `docker` that fail closed; process-tree termination on timeout and cancellation.
- **Multi-agent tasks.** A task manager with lifecycle states, dependencies (`depends_on`), concurrency limits, per-task timeouts, and a delegation budget. Git-worktree isolation (`concurrency.isolation`) with checked integration and conflict reporting, plus master tools `task_status`, `task_diff`, `integrate_task`, `discard_task`. Workers cannot delegate further.
- **Tools.** `find_files`, multi-file atomic `apply_patch`, multi-edit `edit_file`, `run_check`, `git_status`, background processes (`process_start`, `process_output`, `process_stop`), and versioned shared notes with session or project scope.
- **Providers.** Streaming for Anthropic, Gemini, Ollama, and OpenAI-compatible endpoints; retry with exponential backoff, jitter, and `Retry-After`; an error taxonomy (auth, rate limit, overloaded, context overflow, …); capability resolution; fallback across models without replaying tool calls.
- **Usage and budgets.** Token and estimated cost tracking from `pricing`, `/usage`, and `budgets.maxCostUsd`, `maxTokens`, `maxRuntimeMs`.
- **Terminal UX.** Streaming output, first Ctrl+C cancels and second Ctrl+C exits, `--verbose` shows per-agent tool detail and reasoning, plus `/tasks` and `/verify`.
- `mar config migrate`, `mar config path`, and sandbox and session-store probes in `mar doctor`.
- Deterministic benchmark harness: `npm run bench`.

### Changed

- Configuration version 2. Version 1 files still load (new fields take defaults). `mar config migrate` rewrites the file and keeps a `.v1.bak` backup.
- `apply_patch` refuses a hunk whose context matches several locations instead of guessing.
- `edit_file` refuses to edit a file that changed since it was last read.
- Approval prompts are denied automatically when no interactive terminal is attached (previously they could block).
- The baseline command denylist is now configurable (`runtime.denyCommands`) and applies in every approval mode.

## 0.1.0 - 2026-09-01

- Initial multi-agent coding runtime and interactive onboarding.
- OpenAI-compatible, Anthropic, Gemini, and Ollama adapters with tool calling.
- Master/worker delegation, parallel worker batches, model fallbacks, and shared notes.
- Workspace file/search/command/diff tools with approval modes and safety boundaries.
- Provider and tool plugin API.
- Bash, npm, pnpm, Yarn, and Bun distribution paths.
- Built-in JavaScript search fallback for systems without ripgrep.
- Precompiled production artifacts for toolchain-free GitHub package installs.
