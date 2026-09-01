import type { RuntimeSchema, SchemaBundle } from "../schema/types.js";
import type { ResolvedEnums } from "../schema/enum-source.js";

/**
 * Configuration for a provider.
 */
export interface ProviderConfig {
  /** Model identifier, e.g. "gpt-4o" */
  model: string;
  /** Optional temperature override (0-2) */
  temperature?: number;
  /** Optional max tokens for the response */
  maxTokens?: number;
}

/**
 * Request sent to a provider for structured output.
 */
export interface ProviderRequest {
  /** System prompt with semantic context */
  systemPrompt: string;
  /** User input to coerce */
  userInput: string;
  /** JSON Schema for structured output */
  jsonSchema: Record<string, unknown>;
  /** The runtime schema being targeted */
  schema: RuntimeSchema;
  /**
   * Bundle used to resolve nested schemas, when one was supplied.
   *
   * `jsonSchema` above is already built against this bundle in the
   * OpenAI-strict dialect. Providers whose API wants a different dialect
   * should re-derive from `schema` + `bundle` rather than reaching for
   * `schema` alone — dropping the bundle silently emits nested objects with
   * no properties.
   */
  bundle?: SchemaBundle;
  /**
   * Legal values for the schema's `dynamicEnum` sources, already resolved.
   * A provider that re-derives its own JSON Schema must pass these along —
   * dropping them silently widens those fields back to free-form strings.
   */
  resolvedEnums?: ResolvedEnums;
}

/**
 * Response from a provider.
 */
export interface ProviderResponse {
  /** The parsed structured output */
  data: Record<string, unknown>;
  /** Raw response metadata for tracing */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/**
 * Interface that LLM providers must implement.
 */
export interface Provider {
  /**
   * Send a structured output request to the LLM.
   */
  complete(request: ProviderRequest): Promise<ProviderResponse>;
}
