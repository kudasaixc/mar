# Security policy

## Supported versions

Until MAR reaches 1.0, security fixes are applied to the latest released minor version.

## Report a vulnerability

Use GitHub's private vulnerability reporting for `kudasaixc/mar`. Do not open a public issue containing an exploit, credential, or private repository content.

## Threat model

MAR runs language-model output as file edits and shell commands. Assume a model can be wrong, or can be manipulated by malicious repository content (prompt injection in files, issues, dependencies, or tool output). MAR's controls make mistakes visible and limit them. **Only an OS-level sandbox contains a determined adversary**, and only the `bubblewrap` and `docker` backends provide one.

### What each layer does and does not protect

| Layer | Protects against | Does **not** protect against |
|---|---|---|
| Approval modes (`on-request`, `auto-edit`, `never`, `read-only`) | Unreviewed writes and commands; `read-only` refuses every mutating tool | A user approving a harmful request; anything a command does once approved |
| Allow and deny command rules | Accidental use of well-known destructive commands (`rm -rf`, `sudo`, `git push --force`, `git reset --hard`, …) | Deliberate evasion. Rules match parsed command words, so a script, an alias, `bash -c "$(…)"`, or a renamed binary can bypass them. **Rules are not a sandbox.** |
| Workspace path checks (file tools) | Lexical traversal (`../`), absolute paths outside the workspace, symlinks or symlinked parents resolving outside, writes through a symlink | Commands run through `run_command` (on the `host` backend they can touch any file your user can) |
| Stale-write ledger | Overwriting a file that changed after the agent read it (user edits, other agents) | Changes made by shell commands between reads |
| Environment scrubbing | Leaking API keys and tokens into commands: only an allowlist (`PATH`, `HOME`, locale, toolchain roots, …) plus `runtime.envPassthrough` is inherited | Secrets stored in files the command can read |
| Redaction | Configured API keys, values of key-like environment variables, and common token formats (`sk-…`, `ghp_…`, `AKIA…`, bearer headers, PEM keys) in terminal output, session journals, project memory, and audit logs | Secrets in unknown formats; secrets containing whitespace split across streamed chunks (they are caught in the final text, but may appear briefly in the live stream) |
| Process control | Runaway commands: timeouts, output limits, and cancellation kill the whole process group (POSIX) or tree (`taskkill /T` on Windows) | Processes that deliberately leave their process group (`setsid`, double fork) on the `host` backend |
| `bubblewrap` sandbox | Commands see only the workspace (read-write), system directories (read-only), and an empty `$HOME` and `/tmp`; network is off unless `sandbox.network` is true; the process dies with MAR | Kernel exploits; reads of world-readable system files such as `/etc`; anything done by MAR's own in-process file tools or by plugins, which run outside the sandbox |
| `docker` sandbox | Same filesystem scoping inside a container with all capabilities dropped, `no-new-privileges`, a PID limit, `--network none` by default, and your UID | Docker daemon misconfiguration; a container runtime escape. **Not exercised by the test suite on the development machine** (no Docker access there); only its fail-closed behavior is tested. |
| `host` backend (default) | Nothing beyond the layers above | Everything. Commands run as your user with full filesystem and network access. `mar doctor` warns about this. |

### Fail-closed behavior

- If the configured sandbox backend is unavailable, MAR **refuses to start**. It never silently falls back to `host`.
- With `concurrency.isolation: "worktree"` outside a Git repository, MAR refuses to start instead of using shared mode.
- Without an interactive terminal, approval requests are **denied** instead of hanging or auto-approving.
- A session already open in another process (or the same process) cannot be resumed twice.
- Interrupted tool calls are never replayed on resume. The model is told the call was interrupted and must re-check the state first.

### Worktree isolation caveats

Delegated workers in `worktree` mode edit a separate Git worktree, and their diff is applied to your working tree only after a clean `git apply --check`. Conflicts leave your files untouched. With the `bubblewrap` or `docker` backend, the worker's command sandbox can write to the worktree and its per-worktree Git directory, but sees the shared object store read-only. On the `host` backend, worktrees separate files but provide **no** security boundary. A worker could still write anywhere on the system.

### Data at rest

- Configuration stores only the **names** of API-key environment variables. `mar config show` hides header values, and `mar doctor` reports only whether a key is set.
- Sessions live under `~/.local/state/mar/sessions` (or `$MAR_STATE_DIR`), are written with user-only permissions, and contain prompts, responses, tool arguments, and redacted tool output, which may include excerpts of your code. Delete them with `mar sessions delete <id>` or remove the directory.
- Project memory (`share_note` with `scope: "project"`) persists across sessions next to the session store and is redacted on write.

### Plugins

Provider and tool plugins are arbitrary local code running with your privileges, outside any sandbox. Load only plugins you trust. A tool plugin that changes anything must declare `mutating: true` or a `permission`, otherwise approval cannot apply to it.

## Recommendations

- Keep `on-request` or `auto-edit` until you trust your models and configuration.
- For untrusted repositories, models, or plugins, use `sandbox.backend: "bubblewrap"` (Linux) or `"docker"`, or run MAR in a disposable VM with minimal credentials.
- Never place secrets in prompts, project configuration headers, or files accessible to agents.
