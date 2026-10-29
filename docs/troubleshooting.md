# Troubleshooting

Start with `mar doctor`. It checks Node, the workspace, Git, ripgrep, the session store, the configuration, which API-key variables are **set** (never their values), and whether the configured sandbox backend works.

| Symptom | Cause and fix |
|---|---|
| `Sandbox backend "bubblewrap" is unavailable` | `bwrap` is missing or user namespaces are disabled. Install `bubblewrap`, or on Ubuntu 24.04+ allow unprivileged user namespaces for `bwrap` through AppArmor. MAR never falls back to `host` on its own; choose `--sandbox host` explicitly if you accept that. |
| `Sandbox backend "docker" is unavailable` | The Docker CLI or daemon is unreachable, or your user cannot access the socket. Check with `docker info`. |
| `isolation is "worktree" but the workspace is not a Git work tree` | You set `concurrency.isolation: "worktree"` outside a repo. Use `auto` or `shared`, or run `git init`. |
| A task shows `conflict` | The worker's diff no longer applies to your working tree (you or another worker changed the same lines). Your files were not modified. Inspect with `task_diff` (ask the master) or in the kept worktree whose path is printed in the task error. Then `integrate_task` after resolving, or `discard_task`. |
| `approval needed but no interactive terminal` | MAR was run without a TTY (CI, pipes), so approval requests are denied. Use `--approval auto-edit`, `--yes`, or allow rules (`runtime.allowCommands`). |
| `Session … is already open in process N` | Another MAR process owns that session. Close it, or wait. If that process crashed, its lock is detected as stale and the session shows `interrupted`. |
| Answers lose earlier details in long sessions | Compaction ran (`agent:compaction` in `--verbose`). Check `/context`. Raise `capabilities.contextWindow` if your model really supports more, or lower `context.maxToolResultChars`. |
| `context_overflow` after a retry | Even a compacted history exceeded the model's real window. Set `capabilities.contextWindow` to the true value, since local models often default to small windows. |
| Garbled or duplicated streamed text | The endpoint's streaming is non-standard. Set `"stream": false` on that provider. |
| `rate_limit` / `overloaded` warnings | MAR retries with backoff and honors `Retry-After`. Tune `runtime.retry` or add `fallbacks`. |
| `Result: completed · verification unverified` | Files changed but no check ran. Configure `runtime.checks` and pass `--verify`, or ask the agent to run them. MAR never treats the model's claim as proof. |
| A command cannot see an environment variable | Commands receive a scrubbed environment. Add the variable to `runtime.envPassthrough`. |
| Cost shows "No pricing configured" | Add a `pricing` entry for that `provider/model`. Costs are never guessed. |

Session journals live under `~/.local/state/mar/sessions/<id>/journal.jsonl` and are useful for bug reports. Review them before sharing: they are redacted, but may contain your code.
