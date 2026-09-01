import { ProviderError } from "../errors.js";
export function joinUrl(base, path) {
    return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}
export function requireApiKey(providerId, envName) {
    if (!envName)
        return undefined;
    const value = process.env[envName];
    if (!value) {
        throw new ProviderError(`Provider "${providerId}" requires environment variable ${envName}.`);
    }
    return value;
}
export async function fetchJson(url, init, timeoutMs = 180_000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { ...init, signal: controller.signal });
        const text = await response.text();
        let body = {};
        try {
            body = text ? JSON.parse(text) : {};
        }
        catch {
            if (!response.ok)
                throw new ProviderError(`Provider returned HTTP ${response.status}: ${text.slice(0, 500)}`, response.status);
            throw new ProviderError("Provider returned a non-JSON response.", response.status);
        }
        if (!response.ok) {
            const detail = body.error?.message ?? body.error ?? body.message ?? text.slice(0, 500);
            throw new ProviderError(`Provider returned HTTP ${response.status}: ${String(detail)}`, response.status);
        }
        return body;
    }
    catch (error) {
        if (error instanceof ProviderError)
            throw error;
        if (error instanceof Error && error.name === "AbortError") {
            throw new ProviderError(`Provider request timed out after ${timeoutMs}ms.`, undefined, error);
        }
        throw new ProviderError(`Provider request failed: ${error instanceof Error ? error.message : String(error)}`, undefined, error);
    }
    finally {
        clearTimeout(timer);
    }
}
export function parseArguments(value) {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        return value;
    }
    if (typeof value !== "string" || value.trim() === "")
        return {};
    try {
        const parsed = JSON.parse(value);
        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
            ? parsed
            : { value: parsed };
    }
    catch {
        return { raw: value };
    }
}
export function contentToString(content) {
    if (typeof content === "string")
        return content;
    if (!Array.isArray(content))
        return "";
    return content.map((part) => {
        if (typeof part === "string")
            return part;
        if (part && typeof part === "object" && "text" in part && typeof part.text === "string")
            return part.text;
        return "";
    }).join("");
}
//# sourceMappingURL=http.js.map