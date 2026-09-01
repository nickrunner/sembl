import type { ProviderConfig } from "@sembl/core";

/**
 * Configuration specific to the OpenAI provider.
 */
export interface OpenAIProviderConfig extends ProviderConfig {
  /** OpenAI API key. Defaults to OPENAI_API_KEY env var. */
  apiKey?: string;
  /** Base URL for the OpenAI API. Defaults to OpenAI's production endpoint. */
  baseURL?: string;
  /**
   * How many times the SDK retries a failed call before giving up. The SDK
   * retries connection errors, 408/409/429 and 5xx with exponential backoff
   * and honours `retry-after`, so there is nothing to hand-roll here.
   *
   * Defaults to {@link DEFAULT_MAX_RETRIES}.
   */
  maxRetries?: number;
  /**
   * Timeout for a single attempt, in milliseconds. Retries each get their
   * own attempt, so the worst-case wall clock is roughly
   * `timeoutMs * (maxRetries + 1)` plus backoff.
   *
   * Defaults to {@link DEFAULT_TIMEOUT_MS}.
   */
  timeoutMs?: number;
}

/** Matches the SDK's own default; stated here so it survives an SDK change. */
export const DEFAULT_MAX_RETRIES = 2;

/**
 * Two minutes per attempt. The SDK's own default is ten, which is a long time
 * for a backend import to sit on one record when the retry is cheap.
 */
export const DEFAULT_TIMEOUT_MS = 120_000;
