# Configuration reference

MAR reads `~/.config/mar/config.json`, then overlays the nearest `mar.config.json` found from the workspace upward. Use `--config PATH` to load one explicit file without project discovery.

## Providers

Every provider has a unique alias and a `kind`:

- `openai-compatible`: `baseUrl`, optional `apiKeyEnv`, `headers`, and `options`.
- `anthropic`: optional `baseUrl`, `apiKeyEnv` (defaults to `ANTHROPIC_API_KEY`), `headers`, and `options`.
- `gemini`: optional `baseUrl`, `apiKeyEnv` (defaults to `GEMINI_API_KEY`), `headers`, and `options`.
- `ollama`: optional `baseUrl` (defaults to `http://localhost:11434`), `headers`, and `options`.
- `plugin`: a package name or absolute module path in `module`.

`headers` must not contain literal secrets in a committed project configuration. Prefer provider plugins or environment-based authentication for nonstandard schemes.

OpenAI-compatible example:

```json
{
  "kind": "openai-compatible",
  "baseUrl": "http://localhost:1234/v1",
  "options": { "seed": 42 }
}
```

## Agents

Required fields are `name`, `description`, `provider`, and `model`. Optional fields:

- `systemPrompt`: extra role instructions appended to MAR's safety and workflow prompt;
- `temperature`, `maxTokens`, `maxTurns`;
- `options`: provider request fields for this agent;
- `fallbacks`: ordered `{ "provider", "model" }` references tried after request failures.

Agent names must be unique. The master receives the `delegate` tool only when workers exist.

## Runtime

- `approval`: `on-request`, `never` (autonomous), or `read-only`;
- `commandTimeoutMs`: maximum command duration;
- `maxToolOutput`: maximum returned characters before truncation;
- `plugins`: tool-plugin package names or paths relative to the workspace.

CLI flags `--yes` and `--read-only` override the configured approval mode for one invocation.

## Environment overrides

- `MAR_CONFIG_DIR`: directory containing the global `config.json`;
- `MAR_STATE_DIR`: directory for session JSONL files;
- `NO_COLOR`: disable ANSI colors;
- `MAR_INSTALL_DIR`, `MAR_BIN_DIR`, `MAR_VERSION`: installer controls.
