# Plugins

MAR accepts ESM provider and tool plugins with API version 1. Install plugins using the same package manager as MAR, or reference an absolute/local `.mjs` file.

Plugins execute with the current user's privileges. Only load code you trust.

## Tool plugin

```js
import { defineToolPlugin } from "@kudasaixc/mar/plugin";

export default defineToolPlugin({
  apiVersion: 1,
  tools: ({ workspace }) => [{
    spec: {
      name: "project_identity",
      description: "Return the active workspace.",
      parameters: { type: "object", properties: {}, additionalProperties: false }
    },
    mutating: false,
    execute: async (_arguments, context) => ({
      ok: true,
      output: `${context.agent} is working in ${workspace}`
    })
  }]
});
```

Add its package name or workspace-relative path to `runtime.plugins`.

Declare what a tool can do so the security policy can apply:

- `permission: "read"`: never changes anything. Allowed in every mode, including `read-only`, and may run concurrently with other reads.
- `permission: "write"`: changes workspace files. Asks in `on-request`, allowed in `auto-edit` and `never`.
- `permission: "execute"`: runs processes or changes anything outside the workspace. Asks in `on-request` and `auto-edit`.
- `mutating: true` without `permission` means `execute`, and `mutating: false` means `read` (0.1 compatibility).
- `command(args)` (optional): returns the command string or argv the call will run, so allow and deny rules and approval prompts can see it.
- `summarize(args)` (optional): a one-line description shown in approval prompts.

`execute(args, context)` receives `context.signal`, an `AbortSignal` that fires on Ctrl+C or task timeout. Long-running tools must honor it. Return `{ ok, output, meta? }`, where `ok: false` means the call failed. Set `meta.modifiedFiles` (workspace-relative paths) when you change files, so verification can account for them. A mutating call without it is reported as "may have changed files".

Plugins run in MAR's process with your privileges, outside any sandbox backend.

## Provider plugin

```js
import { defineProviderPlugin } from "@kudasaixc/mar/plugin";

export default defineProviderPlugin({
  apiVersion: 1,
  createProvider: ({ providerId, config, fetch }) => ({
    id: providerId,
    async complete(request) {
      // Translate request, call the provider with fetch, and normalize the reply.
      return { content: "implemented by your adapter", toolCalls: [] };
    }
  })
});
```

Reference it as a provider:

```json
{
  "kind": "plugin",
  "module": "@your-scope/mar-provider"
}
```

Provider plugins receive the provider configuration, environment, and global `fetch`. They must return a `ModelAdapter`; optional `listModels()` enables `mar models --available`.
