import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ConfigurationError } from "../errors.js";
import { AnthropicAdapter } from "./anthropic.js";
import { GeminiAdapter } from "./gemini.js";
import { OllamaAdapter } from "./ollama.js";
import { OpenAICompatibleAdapter } from "./openai-compatible.js";
export class ProviderRegistry {
    adapters = new Map();
    constructor() { }
    static async create(config) {
        const registry = new ProviderRegistry();
        for (const [id, provider] of Object.entries(config.providers)) {
            registry.adapters.set(id, await registry.createAdapter(id, provider));
        }
        return registry;
    }
    async createAdapter(id, config) {
        switch (config.kind) {
            case "openai-compatible": return new OpenAICompatibleAdapter(id, config);
            case "anthropic": return new AnthropicAdapter(id, config);
            case "gemini": return new GeminiAdapter(id, config);
            case "ollama": return new OllamaAdapter(id, config);
            case "plugin": {
                if (!config.module)
                    throw new ConfigurationError(`Plugin provider "${id}" has no module.`);
                const specifier = config.module.startsWith(".") || isAbsolute(config.module)
                    ? pathToFileURL(resolve(config.module)).href
                    : config.module;
                const imported = await import(specifier);
                const plugin = imported.default ?? imported.plugin;
                if (!plugin || plugin.apiVersion !== 1 || typeof plugin.createProvider !== "function") {
                    throw new ConfigurationError(`Module "${config.module}" is not a MAR provider plugin v1.`);
                }
                return plugin.createProvider({ providerId: id, config, env: process.env, fetch });
            }
        }
    }
    get(id) {
        const adapter = this.adapters.get(id);
        if (!adapter)
            throw new ConfigurationError(`Unknown provider "${id}".`);
        return adapter;
    }
    entries() {
        return [...this.adapters.entries()];
    }
}
//# sourceMappingURL=registry.js.map