const BASE = { contextWindow: 32_000, maxOutputTokens: 8_192, tools: true, streaming: true, parallelToolCalls: true };
/**
 * Conservative built-in hints by provider kind and model family. They err on the
 * small side: underestimating only compacts earlier, while overestimating causes
 * provider overflow errors (which are also recovered from). Configuration
 * (`capabilities` on the provider or agent) always wins.
 */
const FAMILY = [
    [/claude/i, { contextWindow: 200_000, maxOutputTokens: 16_000 }],
    [/gemini/i, { contextWindow: 1_000_000, maxOutputTokens: 16_000 }],
    [/gpt-4\.1|gpt-5|o[34]-|^o[134]$/i, { contextWindow: 200_000, maxOutputTokens: 16_000 }],
    [/gpt-4o|gpt-4-turbo/i, { contextWindow: 128_000, maxOutputTokens: 16_000 }],
    [/qwen.*coder|qwen3/i, { contextWindow: 32_000 }],
    [/deepseek/i, { contextWindow: 64_000 }],
    [/llama-?3\.[1-3]|llama3\.[1-3]/i, { contextWindow: 128_000 }],
    [/mistral|codestral|devstral/i, { contextWindow: 128_000 }],
];
const KIND = {
    "openai-compatible": {},
    anthropic: { contextWindow: 200_000 },
    gemini: { contextWindow: 1_000_000, parallelToolCalls: true },
    // Ollama silently truncates prompts beyond num_ctx; MAR sends num_ctx = contextWindow.
    ollama: { contextWindow: 16_384, parallelToolCalls: false },
    plugin: {},
};
export function resolveCapabilities(kind, model, ...overrides) {
    const family = FAMILY.find(([pattern]) => pattern.test(model))?.[1] ?? {};
    let result = { ...BASE, ...KIND[kind], ...(kind === "ollama" ? {} : family) };
    for (const override of overrides)
        if (override)
            result = { ...result, ...definedOnly(override) };
    result.maxOutputTokens = Math.min(result.maxOutputTokens, Math.floor(result.contextWindow / 2));
    return result;
}
function definedOnly(value) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
//# sourceMappingURL=capabilities.js.map