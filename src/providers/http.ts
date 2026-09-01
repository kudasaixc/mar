import { ProviderError } from "../errors.js";

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export function requireApiKey(providerId: string, envName?: string): string | undefined {
  if (!envName) return undefined;
  const value = process.env[envName];
  if (!value) {
    throw new ProviderError(`Provider "${providerId}" requires environment variable ${envName}.`);
  }
  return value;
}

export async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs = 180_000,
): Promise<Record<string, any>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let body: Record<string, any> = {};
    try {
      body = text ? JSON.parse(text) as Record<string, any> : {};
    } catch {
      if (!response.ok) throw new ProviderError(`Provider returned HTTP ${response.status}: ${text.slice(0, 500)}`, response.status);
      throw new ProviderError("Provider returned a non-JSON response.", response.status);
    }
    if (!response.ok) {
      const detail = body.error?.message ?? body.error ?? body.message ?? text.slice(0, 500);
      throw new ProviderError(`Provider returned HTTP ${response.status}: ${String(detail)}`, response.status);
    }
    return body;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new ProviderError(`Provider request timed out after ${timeoutMs}ms.`, undefined, error);
    }
    throw new ProviderError(`Provider request failed: ${error instanceof Error ? error.message : String(error)}`, undefined, error);
  } finally {
    clearTimeout(timer);
  }
}

export function parseArguments(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || value.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { value: parsed };
  } catch {
    return { raw: value };
  }
}

export function contentToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (part && typeof part === "object" && "text" in part && typeof part.text === "string") return part.text;
    return "";
  }).join("");
}
