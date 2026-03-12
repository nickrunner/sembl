import type { RuntimeSchema } from "../schema/types.js";

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
