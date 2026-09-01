# Security policy

## Supported versions

Until MAR reaches 1.0, security fixes are applied to the latest released minor version.

## Report a vulnerability

Use GitHub's private vulnerability reporting for `kudasaixc/mar`. Do not open a public issue containing an exploit, credential, or private repository content.

## Trust model

MAR lets language models request file writes and shell commands. Interactive approval (`on-request`) is the default. `--yes` or `approval: "never"` is an explicit grant to perform mutating tool calls without confirmation.

MAR provides defense in depth, not a complete sandbox:

- file tools reject lexical path traversal and symlinks resolving outside the workspace;
- files are written atomically and individual file size is limited;
- command time and output are limited;
- obvious destructive commands and remote pipe-to-shell patterns are blocked;
- secrets are referenced by environment-variable name and are not stored by onboarding;
- sessions are written with user-only permissions outside the project.

Session logs contain prompts, agent responses, tool metadata, and final results, which may include excerpts of project data. Protect or periodically remove `~/.local/state/mar/sessions` according to your retention needs.

Shell commands still run as the current OS user and can potentially evade string-based policy. Plugins are arbitrary local code. For untrusted code, plugins, or models, run MAR inside a disposable container or VM with minimal credentials and network access.

Review every approval request. Never place secrets in prompts, project config headers, or files accessible to agents.
