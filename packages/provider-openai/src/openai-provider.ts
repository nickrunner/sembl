import OpenAI from "openai";
import type { ContentBlock, Provider, ProviderRequest, ProviderResponse } from "@sembl/core";
import { toBase64 } from "@sembl/core";
import type { OpenAIProviderConfig } from "./openai-config.js";
import { DEFAULT_MAX_RETRIES, DEFAULT_TIMEOUT_MS } from "./openai-config.js";
import { OpenAIProviderError, toProviderError } from "./errors.js";
import { toResponseFormat } from "./schema-converter.js";

/**
 * The first user turn. A text-only request goes as a plain string, exactly
 * as before images existed; one with blocks goes as content parts. Images
 * are `image_url` parts — a data URL for inline bytes, the URL itself
 * otherwise. Documents are `file` parts carrying the PDF as a data URL in
 * `file_data`, which is the only form chat completions take inline: there
 * is no URL form, so a document given by URL is refused here rather than
 * silently turned into a filename the model cannot open.
 */
function renderInput(request: ProviderRequest): string | OpenAI.ChatCompletionContentPart[] {
  if (!request.content) return request.userInput;
  return request.content.map(toContentPart);
}

function toContentPart(block: ContentBlock): OpenAI.ChatCompletionContentPart {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "image":
      return {
        type: "image_url",
        image_url: {
          url: "url" in block.source
            ? block.source.url
            : `data:${block.source.mediaType};base64,${toBase64(block.source.data)}`,
        },
      };
    case "document": {
      if ("url" in block.source) {
        throw new RangeError(
          `OpenAI chat completions take a PDF only as bytes, not by URL${block.label !== undefined ? ` (source "${block.label}")` : ""}. ` +
            "Fetch the document first and pass its bytes as `document: { data, mediaType }`.",
        );
      }
      return {
        type: "file",
        file: {
          filename: `${(block.label ?? "document").replace(/[^\w.-]+/g, "_")}.pdf`,
          file_data: `data:${block.source.mediaType};base64,${toBase64(block.source.data)}`,
        },
      };
    }
  }
}

/**
 * OpenAI provider implementation using structured outputs (json_schema response_format).
 *
 * Retries and timeouts are the SDK's (exponential backoff, `retry-after`
 * aware); this class only chooses the numbers and translates whatever comes
 * back out into an {@link OpenAIProviderError}.
 */
export class OpenAIProvider implements Provider {
  /** Repair turns are rendered as assistant and user messages. */
  readonly supportsHistory = true;
  /** Images go as `image_url` parts, inline as a data URL or by URL. */
  readonly supportsImages = true;
  /**
   * PDFs go as `file` parts with the bytes inline. Only inline: chat
   * completions have no URL form for files, so a document given by URL is
   * rejected by `complete` with a message saying to fetch it first.
   */
  readonly supportsDocuments = true;

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

    // Rendered before the try so a bad request fails as the RangeError it
    // is, not as a provider error dressed up as an API failure.
    const input = renderInput(request);

    let completion;
    try {
      completion = await this.client.chat.completions.create({
        model: this.config.model,
        // Only when configured: reasoning models reject sampling parameters.
        ...(this.config.temperature !== undefined ? { temperature: this.config.temperature } : {}),
        max_tokens: this.config.maxTokens,
        messages: [
          { role: "system", content: request.systemPrompt },
          { role: "user", content: input },
          ...(request.history ?? []).map((turn) =>
            turn.role === "assistant"
              ? { role: "assistant" as const, content: JSON.stringify(turn.data) }
              : { role: "user" as const, content: turn.text },
          ),
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
