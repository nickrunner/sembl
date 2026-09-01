import type Anthropic from "@anthropic-ai/sdk";
import type { ProviderConfig } from "@sembl/core";

/**
 * Configuration specific to the Anthropic provider.
 *
 * Supply either `client` or `apiKey`. Prefer `client` when the host app
 * already resolves credentials its own way (Secret Manager, Vault, Bedrock,
 * a Vertex client) — the provider will reuse that client as-is rather than
 * constructing its own.
 */
export interface AnthropicProviderConfig extends ProviderConfig {
  /**
   * A pre-built Anthropic client. Takes precedence over `apiKey`/`baseURL`.
   * Also accepts an `AnthropicBedrock` / `AnthropicVertex` client — anything
   * exposing a compatible `messages.create`.
   */
  client?: Pick<Anthropic, "messages">;
  /** Anthropic API key. Ignored when `client` is supplied. */
  apiKey?: string;
  /** Base URL override. Ignored when `client` is supplied. */
  baseURL?: string;
  /**
   * Name given to the extraction tool the model is forced to call.
   * Defaults to a sanitized form of the schema id. Only override this if a
   * name shows up somewhere you care about (logs, prompt-cache keys).
   */
  toolName?: string;
  /**
   * Mark the stable prefix of the request — the tool definition and the
   * system prompt — as cacheable, so a run of calls against the same schema
   * pays to process it once instead of once per call.
   *
   * Off by default: a cache write costs more than an ordinary read of the
   * same tokens, so a single call, or a prefix below the model's minimum
   * cacheable length, comes out slightly behind. Turn it on for batches.
   * `ProviderResponse.usage.cacheReadTokens` says whether it is paying off.
   */
  cachePrompt?: boolean;
  /**
   * Lifetime of the cached prefix. Ignored unless `cachePrompt` is set.
   *
   * `"5m"` (the default) is refreshed by every read, so back-to-back calls
   * keep it alive indefinitely and it is the cheaper write. Choose `"1h"`
   * only for traffic with gaps longer than five minutes between calls — it
   * survives the gap, but the write costs roughly twice as much.
   */
  cacheTtl?: "5m" | "1h";
  /**
   * How many times the SDK retries a failed call before giving up. The SDK
   * retries connection errors, 408/409/429 and 5xx with exponential backoff
   * and honours `retry-after`, so there is nothing to hand-roll here.
   *
   * Defaults to {@link DEFAULT_MAX_RETRIES}. When a `client` is supplied,
   * leaving this unset keeps that client's own policy.
   */
  maxRetries?: number;
  /**
   * Timeout for a single attempt, in milliseconds. Retries each get their
   * own attempt, so the worst-case wall clock is roughly
   * `timeoutMs * (maxRetries + 1)` plus backoff.
   *
   * Defaults to {@link DEFAULT_TIMEOUT_MS}. When a `client` is supplied,
   * leaving this unset keeps that client's own policy.
   */
  timeoutMs?: number;
}

/** Anthropic requires an explicit output budget; this is used when none is set. */
export const DEFAULT_MAX_TOKENS = 4096;

/** Matches the SDK's own default; stated here so it survives an SDK change. */
export const DEFAULT_MAX_RETRIES = 2;

/**
 * Two minutes per attempt. The SDK's own default is ten, which is a long time
 * for a backend import to sit on one listing when the retry is cheap.
 */
export const DEFAULT_TIMEOUT_MS = 120_000;
