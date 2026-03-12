import type { ProviderConfig } from "@sembl/core";

/**
 * Configuration specific to the OpenAI provider.
 */
export interface OpenAIProviderConfig extends ProviderConfig {
  /** OpenAI API key. Defaults to OPENAI_API_KEY env var. */
  apiKey?: string;
  /** Base URL for the OpenAI API. Defaults to OpenAI's production endpoint. */
  baseURL?: string;
}
