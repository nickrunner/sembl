import Anthropic from "@anthropic-ai/sdk";
import type { ContentBlock, Provider, ProviderRequest, ProviderResponse, ProviderTurn } from "@sembl/core";
import { toBase64 } from "@sembl/core";
import type { AnthropicProviderConfig } from "./anthropic-config.js";
import {
  DEFAULT_MAX_RETRIES,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TIMEOUT_MS,
  isClaude5Model,
} from "./anthropic-config.js";
import { AnthropicProviderError, toProviderError } from "./errors.js";
import { toInputSchema, toToolName } from "./schema-converter.js";

/**
 * Earlier turns as the API saw them: the model's rejected output as the
 * tool call it made, the correction as that call's result flagged as an
 * error. The forced tool choice then makes the model call the tool again,
 * which is the corrected attempt. Ids only have to match within the
 * conversation, so they are synthesised.
 */
function renderHistory(history: readonly ProviderTurn[], toolName: string): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [];
  let lastToolUseId = "";
  history.forEach((turn, i) => {
    if (turn.role === "assistant") {
      lastToolUseId = `toolu_sembl_${i}`;
      messages.push({
        role: "assistant",
        content: [{ type: "tool_use", id: lastToolUseId, name: toolName, input: turn.data }],
      });
    } else if (lastToolUseId) {
      messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: lastToolUseId, content: turn.text, is_error: true }],
      });
    } else {
      messages.push({ role: "user", content: turn.text });
    }
  });
  return messages;
}

/**
 * The first user turn. A text-only request goes as a plain string, exactly
 * as before images existed; one with blocks goes as a content array, each
 * image or document as the block the API defines for it, inline as base64
 * or by URL for the API to fetch.
 */
function renderInput(request: ProviderRequest): string | Anthropic.ContentBlockParam[] {
  if (!request.content) return request.userInput;
  return request.content.map(toContentBlock);
}

function toContentBlock(block: ContentBlock): Anthropic.ContentBlockParam {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "image":
      return {
        type: "image",
        source:
          "url" in block.source
            ? { type: "url", url: block.source.url }
            : { type: "base64", media_type: block.source.mediaType, data: toBase64(block.source.data) },
      };
    case "document":
      return {
        type: "document",
        source:
          "url" in block.source
            ? { type: "url", url: block.source.url }
            : { type: "base64", media_type: block.source.mediaType, data: toBase64(block.source.data) },
        ...(block.label !== undefined ? { title: block.label } : {}),
      };
  }
}

/** Per-call overrides handed to the SDK alongside the request body. */
interface CallOptions {
  maxRetries?: number;
  timeout?: number;
}

/**
 * Anthropic provider implementation.
 *
 * Structured output is obtained by declaring the target schema as a single
 * tool and forcing the model to call it (`tool_choice: { type: "tool" }`), so
 * the arguments come back already parsed and shape-checked by the API — no
 * JSON scraped out of prose.
 *
 * Retries and timeouts are the SDK's (exponential backoff, `retry-after`
 * aware); this class only chooses the numbers and translates whatever comes
 * back out into an {@link AnthropicProviderError}.
 */
export class AnthropicProvider implements Provider {
  /** Repair turns are rendered as a tool call and its (failed) result. */
  readonly supportsHistory = true;
  /** Images go as `image` blocks, inline or by URL. */
  readonly supportsImages = true;
  /** PDFs go as `document` blocks, inline or by URL. */
  readonly supportsDocuments = true;

  private client: Pick<Anthropic, "messages">;
  private config: AnthropicProviderConfig;
  private callOptions: CallOptions | undefined;

  constructor(config: AnthropicProviderConfig) {
    this.config = config;

    if (config.client) {
      // The host owns this client's transport policy, so only override it
      // per-call where the caller asked for something specific.
      this.client = config.client;
      this.callOptions =
        config.maxRetries === undefined && config.timeoutMs === undefined
          ? undefined
          : { maxRetries: config.maxRetries, timeout: config.timeoutMs };
    } else {
      this.client = new Anthropic({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
        timeout: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
      this.callOptions = undefined;
    }
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const toolName = this.config.toolName ?? toToolName(request.schema.id);
    const maxTokens = this.config.maxTokens ?? DEFAULT_MAX_TOKENS;
    const inputSchema = toInputSchema(
      request.schema,
      request.bundle,
      request.resolvedEnums,
    );

    // Sampling parameters go only when configured: newer models reject
    // `temperature` (and `top_p`/`top_k`) outright, and structured
    // extraction does not need them.
    const thinking = this.config.thinking ?? (isClaude5Model(this.config.model) ? { type: "disabled" as const } : undefined);
    const message = await this.send(
      {
        model: this.config.model,
        max_tokens: maxTokens,
        ...(this.config.temperature !== undefined ? { temperature: this.config.temperature } : {}),
        ...(thinking ? { thinking } : {}),
        system: this.buildSystem(request.systemPrompt),
        messages: [
          { role: "user", content: renderInput(request) },
          ...renderHistory(request.history ?? [], toolName),
        ],
        tools: [
          {
            name: toolName,
            description: request.schema.description,
            input_schema: inputSchema as Anthropic.Tool["input_schema"],
          },
        ],
        tool_choice: { type: "tool", name: toolName },
        ...this.config.requestOverrides,
      },
      this.callOptions,
    );

    const toolUse = message.content.find(
      (block): block is Anthropic.ToolUseBlock =>
        block.type === "tool_use" && block.name === toolName,
    );

    if (!toolUse) {
      if (message.stop_reason === "max_tokens") {
        throw new AnthropicProviderError(
          `Anthropic hit the ${maxTokens}-token output cap before completing the "${toolName}" call. ` +
            "Raise maxTokens, or coerce into a smaller schema.",
          { kind: "truncated", retryable: false, stopReason: "max_tokens" },
        );
      }
      throw new AnthropicProviderError(
        `Anthropic returned no "${toolName}" tool call (stop_reason: ${message.stop_reason ?? "unknown"})`,
        {
          kind: "no_output",
          retryable: false,
          stopReason: message.stop_reason ?? undefined,
        },
      );
    }

    return {
      data: toolUse.input as Record<string, unknown>,
      usage: {
        promptTokens: message.usage.input_tokens,
        completionTokens: message.usage.output_tokens,
        totalTokens: message.usage.input_tokens + message.usage.output_tokens,
        ...(message.usage.cache_read_input_tokens != null && {
          cacheReadTokens: message.usage.cache_read_input_tokens,
        }),
        ...(message.usage.cache_creation_input_tokens != null && {
          cacheWriteTokens: message.usage.cache_creation_input_tokens,
        }),
      },
    };
  }

  /**
   * The system prompt, marked as a cache breakpoint when caching is on.
   *
   * One breakpoint is enough: the API renders `tools` before `system`, so a
   * marker on the trailing system block covers the tool definition too — and
   * the user input, the only part that changes between calls, sits after it
   * in `messages` where it invalidates nothing.
   */
  private buildSystem(
    systemPrompt: string,
  ): string | Anthropic.TextBlockParam[] {
    if (!this.config.cachePrompt) return systemPrompt;

    return [
      {
        type: "text",
        text: systemPrompt,
        cache_control: { type: "ephemeral", ttl: this.config.cacheTtl ?? "5m" },
      },
    ];
  }

  /** Issue the call, translating SDK failures into typed provider errors. */
  private async send(
    body: Anthropic.MessageCreateParamsNonStreaming,
    options: CallOptions | undefined,
  ): Promise<Anthropic.Message> {
    try {
      return await this.client.messages.create(body, options);
    } catch (error) {
      throw toProviderError(error);
    }
  }
}
