import OpenAI from "openai";
import type { Provider, ProviderRequest, ProviderResponse } from "@sembl/core";
import type { OpenAIProviderConfig } from "./openai-config.js";
import { DEFAULT_MAX_RETRIES, DEFAULT_TIMEOUT_MS } from "./openai-config.js";
import { OpenAIProviderError, toProviderError } from "./errors.js";
import { toResponseFormat } from "./schema-converter.js";

/**
 * OpenAI provider implementation using structured outputs (json_schema response_format).
 *
 * Retries and timeouts are the SDK's (exponential backoff, `retry-after`
 * aware); this class only chooses the numbers and translates whatever comes
 * back out into an {@link OpenAIProviderError}.
 */
export class OpenAIProvider implements Provider {
  private client: OpenAI;
  private config: OpenAIProviderConfig;

  constructor(config: OpenAIProviderConfig) {
    this.config = config;
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
      timeout: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const responseFormat = toResponseFormat(
      request.schema,
      request.bundle,
      request.resolvedEnums,
    );

    let completion;
    try {
      completion = await this.client.chat.completions.create({
        model: this.config.model,
        // Only when configured: reasoning models reject sampling parameters.
        ...(this.config.temperature !== undefined ? { temperature: this.config.temperature } : {}),
        max_tokens: this.config.maxTokens,
        messages: [
          { role: "system", content: request.systemPrompt },
          { role: "user", content: request.userInput },
        ],
        response_format: responseFormat,
      });
    } catch (error) {
      throw toProviderError(error);
    }

    const choice = completion.choices[0];

    // A truncated response is a budget problem, not a content one: the JSON is
    // cut mid-object, so it would only fail to parse a step later.
    if (choice?.finish_reason === "length") {
      const cap = this.config.maxTokens
        ? `the ${this.config.maxTokens}-token output cap`
        : "the model's default output cap";
      throw new OpenAIProviderError(
        `OpenAI hit ${cap} before completing the "${request.schema.id}" object. ` +
          "Raise maxTokens, or coerce into a smaller schema.",
        { kind: "truncated", retryable: false, finishReason: "length" },
      );
    }

    if (choice?.message?.refusal) {
      throw new OpenAIProviderError(
        `OpenAI declined to extract "${request.schema.id}": ${choice.message.refusal}`,
        {
          kind: "no_output",
          retryable: false,
          finishReason: choice.finish_reason,
        },
      );
    }

    if (!choice?.message?.content) {
      throw new OpenAIProviderError(
        `OpenAI returned no content in response (finish_reason: ${choice?.finish_reason ?? "unknown"})`,
        {
          kind: "no_output",
          retryable: false,
          finishReason: choice?.finish_reason,
        },
      );
    }

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(choice.message.content) as Record<string, unknown>;
    } catch (error) {
      throw new OpenAIProviderError(
        `OpenAI returned content that is not valid JSON for "${request.schema.id}"`,
        { kind: "no_output", retryable: false, cause: error },
      );
    }

    return {
      data,
      usage: completion.usage
        ? {
            promptTokens: completion.usage.prompt_tokens,
            completionTokens: completion.usage.completion_tokens,
            totalTokens: completion.usage.total_tokens,
            // OpenAI caches long prefixes automatically and reports only what
            // it served from cache — there is no write to account for.
            ...(completion.usage.prompt_tokens_details?.cached_tokens !=
              null && {
              cacheReadTokens:
                completion.usage.prompt_tokens_details.cached_tokens,
            }),
          }
        : undefined,
    };
  }
}
