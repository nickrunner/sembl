import OpenAI from "openai";
import type { Provider, ProviderRequest, ProviderResponse } from "@sembl/core";
import type { OpenAIProviderConfig } from "./openai-config.js";
import { toResponseFormat } from "./schema-converter.js";

/**
 * OpenAI provider implementation using structured outputs (json_schema response_format).
 */
export class OpenAIProvider implements Provider {
  private client: OpenAI;
  private config: OpenAIProviderConfig;

  constructor(config: OpenAIProviderConfig) {
    this.config = config;
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    });
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const responseFormat = toResponseFormat(request.schema, request.bundle);

    const completion = await this.client.chat.completions.create({
      model: this.config.model,
      temperature: this.config.temperature ?? 0,
      max_tokens: this.config.maxTokens,
      messages: [
        { role: "system", content: request.systemPrompt },
        { role: "user", content: request.userInput },
      ],
      response_format: responseFormat,
    });

    const choice = completion.choices[0];
    if (!choice?.message?.content) {
      throw new Error("OpenAI returned no content in response");
    }

    const data = JSON.parse(choice.message.content) as Record<string, unknown>;

    return {
      data,
      usage: completion.usage
        ? {
            promptTokens: completion.usage.prompt_tokens,
            completionTokens: completion.usage.completion_tokens,
            totalTokens: completion.usage.total_tokens,
          }
        : undefined,
    };
  }
}
