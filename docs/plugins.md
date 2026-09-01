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

Add its package name or workspace-relative path to `runtime.plugins`. Set `mutating: true` for anything that can change files, processes, remote state, or user data so MAR applies its approval mode.

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
