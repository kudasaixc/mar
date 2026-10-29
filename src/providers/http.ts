import { isContextOverflowMessage, kindFromStatus, ProviderError } from "../errors.js";
import { anySignal } from "../util/async.js";

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export function requireApiKey(providerId: string, envName?: string): string | undefined {
  if (!envName) return undefined;
  const value = process.env[envName];
  if (!value) {
    throw new ProviderError(`Provider "${providerId}" requires environment variable ${envName}.`, undefined, undefined, "auth");
  }
  return value;
}

export interface RequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

function retryAfter(response: Response): number | undefined {
  const header = response.headers.get("retry-after-ms") ?? response.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return response.headers.has("retry-after-ms") ? seconds : seconds * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function detailFrom(body: unknown, text: string): string {
  const value = body as Record<string, any> | undefined;
  const raw = value?.error?.message ?? value?.error ?? value?.message ?? value?.detail ?? text.slice(0, 500);
  return typeof raw === "string" ? raw : JSON.stringify(raw).slice(0, 500);
}

export function httpError(response: Response, text: string): ProviderError {
  let body: unknown;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = undefined; }
  const detail = detailFrom(body, text);
  const typed = (body as Record<string, any> | undefined)?.error?.type;
  let kind = kindFromStatus(response.status, detail);
  if (typed === "overloaded_error") kind = "overloaded";
  if (kind === "bad_request" && isContextOverflowMessage(detail)) kind = "context_overflow";
  return new ProviderError(`Provider returned HTTP ${response.status}: ${detail}`, response.status, undefined, kind, retryAfter(response));
}

/** fetch with timeout, user cancellation, and normalized errors. The caller consumes the body. */
export async function request(url: string, init: RequestInit, options: RequestOptions = {}): Promise<{ response: Response; dispose(): void }> {
  const timeoutMs = options.timeoutMs ?? 180_000;
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  const combined = anySignal(options.signal, timeout.signal);
  const dispose = (): void => {
    clearTimeout(timer);
    combined.dispose();
  };
  try {
    const response = await fetch(url, { ...init, signal: combined.signal });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw httpError(response, text);
    }
    return { response, dispose };
  } catch (error) {
    dispose();
    throw normalizeFetchError(error, options.signal, timeout.signal, timeoutMs);
  }
}

export function normalizeFetchError(error: unknown, user?: AbortSignal, timeout?: AbortSignal, timeoutMs?: number): ProviderError {
  if (error instanceof ProviderError) return error;
  if (user?.aborted) return new ProviderError("Request cancelled.", undefined, error, "cancelled");
  if (timeout?.aborted || (error instanceof Error && error.name === "TimeoutError")) {
    return new ProviderError(`Provider request timed out after ${timeoutMs}ms.`, undefined, error, "timeout");
  }
  const message = error instanceof Error ? `${error.message}${error.cause instanceof Error ? ` (${error.cause.message})` : ""}` : String(error);
  return new ProviderError(`Provider request failed: ${message}`, undefined, error, "network");
}

export async function fetchJson(url: string, init: RequestInit, timeoutMsOrOptions: number | RequestOptions = 180_000): Promise<Record<string, any>> {
  const options = typeof timeoutMsOrOptions === "number" ? { timeoutMs: timeoutMsOrOptions } : timeoutMsOrOptions;
  const { response, dispose } = await request(url, init, options);
  try {
    const text = await response.text();
    try {
      const body: unknown = text ? JSON.parse(text) : {};
      if (typeof body !== "object" || body === null) throw new SyntaxError("not an object");
      return body as Record<string, any>;
    } catch {
      throw new ProviderError(`Provider returned a non-JSON response: ${text.slice(0, 200)}`, response.status, undefined, "malformed");
    }
  } catch (error) {
    throw normalizeFetchError(error, options.signal);
  } finally {
    dispose();
  }
}

/** Iterate lines of a streaming response body. */
async function* lines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      yield buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
    }
  }
  buffer += decoder.decode();
  if (buffer) yield buffer;
}

export interface SseEvent {
  event?: string;
  data: string;
}

/** Parse a Server-Sent Events stream. */
export async function* sse(response: Response): AsyncGenerator<SseEvent> {
  if (!response.body) throw new ProviderError("Streaming response has no body.", response.status, undefined, "malformed");
  let event: string | undefined;
  let data: string[] = [];
  for await (const line of lines(response.body)) {
    if (line === "") {
      if (data.length) yield { ...(event ? { event } : {}), data: data.join("\n") };
      event = undefined;
      data = [];
      continue;
    }
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (data.length) yield { ...(event ? { event } : {}), data: data.join("\n") };
}

/** Parse newline-delimited JSON (Ollama streaming). */
export async function* ndjson(response: Response): AsyncGenerator<Record<string, any>> {
  if (!response.body) throw new ProviderError("Streaming response has no body.", response.status, undefined, "malformed");
  for await (const line of lines(response.body)) {
    if (!line.trim()) continue;
    yield parseJson(line);
  }
}

export function parseJson(text: string): Record<string, any> {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === "object" && value !== null) return value as Record<string, any>;
  } catch {
    // Reported below.
  }
  throw new ProviderError(`Malformed streaming chunk: ${text.slice(0, 200)}`, undefined, undefined, "malformed");
}

/** Run a streaming request, translating mid-stream failures into ProviderErrors. */
export async function streamRequest<T>(url: string, init: RequestInit, options: RequestOptions, consume: (response: Response) => Promise<T>): Promise<T> {
  const { response, dispose } = await request(url, init, options);
  try {
    return await consume(response);
  } catch (error) {
    throw normalizeFetchError(error, options.signal);
  } finally {
    dispose();
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

let sequence = 0;
/** Unique tool-call identifier for providers that do not supply one. */
export function syntheticCallId(prefix = "call"): string {
  sequence = (sequence + 1) % 1_000_000;
  return `${prefix}_${Date.now().toString(36)}_${sequence.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Ensure tool-call ids are present and unique within one response. */
export function uniqueCallIds<T extends { id: string }>(calls: T[], prefix = "call"): T[] {
  const seen = new Set<string>();
  return calls.map((call) => {
    let id = call.id;
    if (!id || seen.has(id)) id = syntheticCallId(prefix);
    seen.add(id);
    return id === call.id ? call : { ...call, id };
  });
}
