# Configuration reference

MAR reads `~/.config/mar/config.json` (or `$MAR_CONFIG_DIR/config.json`), then overlays the nearest `mar.config.json` found from the workspace upward. `--config PATH` loads one explicit file without project discovery. `mar config path` prints the files in use, and `mar config show` prints the merged result with header values hidden.

The current schema is **version 2**. Version 1 files load unchanged: every missing field takes its default. `mar config migrate` rewrites the global file as version 2 and keeps `config.json.v1.bak`.

## Providers

Every provider has a unique alias and a `kind`:

- `openai-compatible`: `baseUrl`, plus optional `apiKeyEnv`, `headers`, `options`;
- `anthropic`: optional `baseUrl`, `apiKeyEnv` (default `ANTHROPIC_API_KEY`), `headers`, `options`;
- `gemini`: optional `baseUrl`, `apiKeyEnv` (default `GEMINI_API_KEY`), `headers`, `options`;
- `ollama`: optional `baseUrl` (default `http://localhost:11434`), `headers`, `options`;
- `plugin`: a package name or absolute module path in `module`.

Common optional fields:

- `timeoutMs`: per-request timeout (default 180000);
- `stream`: `false` disables streaming for endpoints that implement it incorrectly;
- `capabilities`: overrides `{ contextWindow, maxOutputTokens, tools, streaming, parallelToolCalls }` for every model of the provider.

`headers` must not contain literal secrets in a committed project configuration.

## Agents

Required fields: `name`, `description`, `provider`, `model`. Optional fields:

- `systemPrompt`: extra role instructions appended to MAR's prompt;
- `temperature`, `maxTokens`, `maxTurns`;
- `options`: provider request fields for this agent;
- `fallbacks`: ordered `{ "provider", "model" }` references, tried after a non-retryable failure or once retries are exhausted;
- `capabilities`: per-agent capability override (highest precedence);
- `compactAt`: per-agent compaction threshold.

Capabilities resolve in this order, later entries winning: built-in model hints, adapter hints, provider `capabilities`, agent `capabilities`. Unknown models get a conservative 32k-token window. Set `contextWindow` explicitly for local models.

## Runtime

| Key | Default | Meaning |
|---|---|---|
| `approval` | `on-request` | `on-request` asks before writes and commands; `auto-edit` allows workspace writes and asks for commands; `never` is autonomous; `read-only` refuses every mutating tool |
| `commandTimeoutMs` | `120000` | Default command timeout (a tool call may request a shorter or longer one) |
| `maxToolOutput` | `30000` | Characters returned to the model per tool result (head and tail kept) |
| `plugins` | `[]` | Tool-plugin package names or workspace-relative paths |
| `sandbox.backend` | `host` | `host` (no isolation), `bubblewrap`, or `docker`. An unavailable backend is a startup error |
| `sandbox.network` | `false` | Network inside `bubblewrap` or `docker` (the `host` backend always has network) |
| `sandbox.image` | `node:22-bookworm` | Docker image |
| `sandbox.readOnlyPaths` | `[]` | Extra read-only paths visible inside the sandbox |
| `allowCommands` | read-only Git and coreutils | Command prefixes that never prompt (except in `read-only` mode) |
| `denyCommands` | `sudo`, `rm -rf`, `git push --force`, … | Command prefixes refused in every mode |
| `envPassthrough` | `[]` | Extra environment variables given to commands (everything else is scrubbed) |
| `checks` | auto-detected | Named verification commands, for example `{ "test": "npm test", "lint": "npm run lint" }` |
| `stream` | `true` | Stream model output to the terminal |
| `context.compactAt` | `0.8` | Fraction of the usable window that triggers compaction |
| `context.targetAfterCompaction` | `0.5` | Target fraction after compaction |
| `context.keepRecentTurns` | `4` | Recent turns kept verbatim |
| `context.maxToolResultChars` | `2000` | Older tool results longer than this are elided to excerpts |
| `context.summarizer` | `model` | `model` or `deterministic` (never calls a model) |
| `concurrency.maxWorkers` | `4` | Delegated tasks running at once |
| `concurrency.isolation` | `auto` | `auto` (worktree in a Git repo, otherwise shared), `worktree`, `shared` |
| `concurrency.workerTimeoutMs` | `1800000` | Per-task timeout |
| `concurrency.maxDelegations` | `32` | Delegations allowed per session |
| `budgets.maxCostUsd` / `maxTokens` / `maxRuntimeMs` | unset | The run stops with `budget_exceeded` when it reaches a limit |
| `retry.maxAttempts` / `baseDelayMs` / `maxDelayMs` | `3` / `1000` / `30000` | Provider retry with exponential backoff and full jitter |

When no `checks` are configured, MAR detects them: `package.json` scripts `test`, `lint`, `typecheck`, `type-check`, `check`, and `build` (run through the package manager indicated by the lockfile); `cargo test` and `cargo check`; `go test ./...`; and `python -m pytest -q` when `pytest.ini`, `pyproject.toml`, or `setup.cfg` exists.

Command-line overrides for one invocation: `--yes` (approval `never`), `--read-only`, `--approval MODE`, `--sandbox BACKEND`, `--verify`, `--verbose`.

## Pricing

Cost figures are **estimates** from your own `pricing` table, not billing data. Keys are `provider/model` or `provider/*`, values are USD per million tokens:

```json
"pricing": {
  "anthropic/*": { "input": 3, "output": 15, "cachedInput": 0.3 },
  "local/*": { "input": 0, "output": 0 }
}
```

Models without pricing are listed as unpriced, and their cost is never guessed. `budgets.maxCostUsd` counts priced models only.

## Environment

- `MAR_CONFIG_DIR`: directory containing the global `config.json`;
- `MAR_STATE_DIR`: directory for sessions (project memory and worktrees live next to it);
- `NO_COLOR`: disable ANSI colors;
- `MAR_INSTALL_DIR`, `MAR_BIN_DIR`, `MAR_VERSION`: installer controls.
