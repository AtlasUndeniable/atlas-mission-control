/**
 * Minimal Anthropic API helper for Mission Control.
 *
 * Uses the Messages API via fetch (no SDK — keeps deps at zero).
 * Supports prompt caching via cache_control breakpoints — callers mark the
 * long, static blocks (voice profile, system prompt) to cache.
 *
 * Env: ANTHROPIC_API_KEY must be set (MC reads .env.local at boot).
 */

const API_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-sonnet-4-5-20250929";

export interface CacheableBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

export interface CallOptions {
  model?: string;
  system: string | CacheableBlock[];
  userMessage: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface CallResult {
  text: string;
  stopReason: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
  };
}

export async function callClaude(opts: CallOptions): Promise<CallResult> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not set");

  const resp = await fetch(API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: opts.model ?? DEFAULT_MODEL,
      max_tokens: opts.maxTokens ?? 1024,
      temperature: opts.temperature ?? 0.7,
      system: opts.system,
      messages: [{ role: "user", content: opts.userMessage }],
    }),
    signal: opts.signal,
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Anthropic ${resp.status}: ${body.slice(0, 300)}`);
  }

  const data = await resp.json();
  const text =
    data.content
      ?.filter((b: { type: string }) => b.type === "text")
      .map((b: { text: string }) => b.text)
      .join("") ?? "";

  return {
    text,
    stopReason: data.stop_reason,
    usage: {
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
      cacheCreationTokens: data.usage?.cache_creation_input_tokens ?? 0,
      cacheReadTokens: data.usage?.cache_read_input_tokens ?? 0,
    },
  };
}
