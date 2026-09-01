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
}

/** Anthropic requires an explicit output budget; this is used when none is set. */
export const DEFAULT_MAX_TOKENS = 4096;
