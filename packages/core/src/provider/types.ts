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
 * One earlier turn of a repair conversation. An assistant turn is the
 * structured output the model produced; a user turn is what was said about
 * it. Providers render them natively — as a tool call and its result, or as
 * assistant and user messages — so the model sees its own rejected answer
 * as its own rather than quoted back to it.
 */
export type ProviderTurn =
  | { role: "assistant"; data: Record<string, unknown> }
  | { role: "user"; text: string };

/**
 * Request sent to a provider for structured output.
 */
export interface ProviderRequest {
  /** System prompt with semantic context */
  systemPrompt: string;
  /** User input to coerce — the first user turn of the conversation. */
  userInput: string;
  /**
   * Turns after `userInput`, in order, for a repair or an empty-result
   * retry: the rejected output as an assistant turn, then the correction as
   * a user turn, and so on. Only sent to a provider whose `supportsHistory`
   * is true; other providers get the correction folded into `userInput`.
   */
  history?: ProviderTurn[];
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
 * Token accounting for a single provider call.
 *
 * The cache fields are reported as the provider reports them, and providers
 * disagree about whether cached tokens also appear in `promptTokens` — so read
 * them as an effectiveness signal, not as terms to add up. Each provider's
 * README states which convention it follows.
 */
export interface ProviderUsage {
  /** Input tokens, as the provider counts them. */
  promptTokens: number;
  /** Output tokens generated. */
  completionTokens: number;
  /** `promptTokens + completionTokens`. */
  totalTokens: number;
  /**
   * Input tokens served from a prompt cache, when the provider reports it.
   * Growing to cover the stable prefix across a batch is the signal that
   * caching is working; a run of zeroes means it is not.
   */
  cacheReadTokens?: number;
  /**
   * Input tokens written to a prompt cache, when the provider reports it.
   * Expect this on the first call of a batch and near zero afterwards; a
   * write on every call means the cached prefix is being invalidated.
   */
  cacheWriteTokens?: number;
}

/**
 * Response from a provider.
 */
export interface ProviderResponse {
  /** The parsed structured output */
  data: Record<string, unknown>;
  /** Raw response metadata for tracing */
  usage?: ProviderUsage;
}

/**
 * Interface that LLM providers must implement.
 */
export interface Provider {
  /**
   * Send a structured output request to the LLM.
   */
  complete(request: ProviderRequest): Promise<ProviderResponse>;
  /**
   * Whether `complete` renders `request.history` as real turns. Leave unset
   * (false) and repair corrections arrive as text inside `userInput`
   * instead, which every provider can handle.
   */
  readonly supportsHistory?: boolean;
}
