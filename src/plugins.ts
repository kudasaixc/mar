import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ConfigurationError } from "./errors.js";
import type { MarToolPlugin } from "./plugin-api.js";
import type { ToolDefinition } from "./tools/types.js";

export async function loadToolPlugins(specifiers: string[], workspace: string): Promise<ToolDefinition[]> {
  const tools: ToolDefinition[] = [];
  for (const specifier of specifiers) {
    const moduleId = specifier.startsWith(".") || isAbsolute(specifier)
      ? pathToFileURL(resolve(workspace, specifier)).href
      : specifier;
    const imported = await import(moduleId) as { default?: MarToolPlugin; plugin?: MarToolPlugin };
    const plugin = imported.default ?? imported.plugin;
    if (!plugin || plugin.apiVersion !== 1 || typeof plugin.tools !== "function") {
      throw new ConfigurationError(`Module "${specifier}" is not a MAR tool plugin v1.`);
    }
    const provided = await plugin.tools({ workspace });
    for (const tool of provided) {
      if (!tool?.spec?.name || typeof tool.execute !== "function" || typeof tool.mutating !== "boolean") {
        throw new ConfigurationError(`Plugin "${specifier}" returned an invalid tool.`);
      }
      tools.push(tool);
    }
  }
  return tools;
}
