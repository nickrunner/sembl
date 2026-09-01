import Anthropic from "@anthropic-ai/sdk";
import type { Provider, ProviderRequest, ProviderResponse } from "@sembl/core";
import type { AnthropicProviderConfig } from "./anthropic-config.js";
import { DEFAULT_MAX_TOKENS } from "./anthropic-config.js";
import { toInputSchema, toToolName } from "./schema-converter.js";

/**
 * Anthropic provider implementation.
 *
 * Structured output is obtained by declaring the target schema as a single
 * tool and forcing the model to call it (`tool_choice: { type: "tool" }`), so
 * the arguments come back already parsed and shape-checked by the API — no
 * JSON scraped out of prose.
 */
export class AnthropicProvider implements Provider {
  private client: Pick<Anthropic, "messages">;
  private config: AnthropicProviderConfig;

  constructor(config: AnthropicProviderConfig) {
    this.config = config;
    this.client =
      config.client ??
      new Anthropic({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
      });
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const toolName = this.config.toolName ?? toToolName(request.schema.id);
    const inputSchema = toInputSchema(
      request.schema,
      request.bundle,
      request.resolvedEnums,
    );

    const message = await this.client.messages.create({
      model: this.config.model,
      max_tokens: this.config.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature: this.config.temperature ?? 0,
      system: request.systemPrompt,
      messages: [{ role: "user", content: request.userInput }],
      tools: [
        {
          name: toolName,
          description: request.schema.description,
          input_schema: inputSchema as Anthropic.Tool["input_schema"],
        },
      ],
      tool_choice: { type: "tool", name: toolName },
    });

    const toolUse = message.content.find(
      (block): block is Anthropic.ToolUseBlock =>
        block.type === "tool_use" && block.name === toolName,
    );

    if (!toolUse) {
      if (message.stop_reason === "max_tokens") {
        throw new Error(
          `Anthropic hit the ${this.config.maxTokens ?? DEFAULT_MAX_TOKENS}-token output cap before completing the "${toolName}" call. ` +
            "Raise maxTokens, or coerce into a smaller schema.",
        );
      }
      throw new Error(
        `Anthropic returned no "${toolName}" tool call (stop_reason: ${message.stop_reason ?? "unknown"})`,
      );
    }

    return {
      data: toolUse.input as Record<string, unknown>,
      usage: {
        promptTokens: message.usage.input_tokens,
        completionTokens: message.usage.output_tokens,
        totalTokens: message.usage.input_tokens + message.usage.output_tokens,
      },
    };
  }
}
