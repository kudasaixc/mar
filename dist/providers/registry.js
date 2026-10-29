import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ConfigurationError } from "../errors.js";
import { AnthropicAdapter } from "./anthropic.js";
import { resolveCapabilities } from "./capabilities.js";
import { GeminiAdapter } from "./gemini.js";
import { OllamaAdapter } from "./ollama.js";
import { OpenAICompatibleAdapter } from "./openai-compatible.js";
export class ProviderRegistry {
    adapters = new Map();
    configs = new Map();
    constructor() { }
    static async create(config) {
        const registry = new ProviderRegistry();
        for (const [id, provider] of Object.entries(config.providers)) {
            registry.adapters.set(id, await registry.createAdapter(id, provider));
            registry.configs.set(id, provider);
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
    /** Effective capabilities: built-in hints < adapter hints < provider config < agent config. */
    capabilities(id, model, override) {
        const config = this.configs.get(id);
        if (!config)
            throw new ConfigurationError(`Unknown provider "${id}".`);
        return resolveCapabilities(config.kind, model, this.get(id).capabilities?.(model), config.capabilities, override);
    }
    /** Whether streaming is enabled for this provider (plugins stream only if they declare it). */
    streams(id) {
        const config = this.configs.get(id);
        return config?.stream !== false;
    }
    entries() {
        return [...this.adapters.entries()];
    }
}
//# sourceMappingURL=registry.js.map