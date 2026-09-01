import { describe, it, expect, vi } from "vitest";
import Anthropic, { APIConnectionError, APIError } from "@anthropic-ai/sdk";
import { AnthropicProvider } from "../anthropic-provider.js";
import { AnthropicProviderError } from "../errors.js";
import {
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
} from "../anthropic-config.js";
import type { RuntimeSchema } from "@sembl/core";

const addressSchema: RuntimeSchema = {
  id: "Address",
  description: "A location.",
  fields: [
    { name: "city", description: "City", type: { kind: "string" }, required: true },
  ],
};

const call = {
  systemPrompt: "sys",
  userInput: "in",
  jsonSchema: {},
  schema: addressSchema,
};

/** Minimal stand-in for the pieces of the SDK client the provider touches. */
function stubClient() {
  const create = vi.fn();
  return { client: { messages: { create } } as never, create };
}

function rejectingClient(error: unknown) {
  const stub = stubClient();
  stub.create.mockRejectedValue(error);
  return stub;
}

function toolUseClient() {
  const stub = stubClient();
  stub.create.mockResolvedValue({
    content: [
      { type: "tool_use", id: "t", name: "extract_Address", input: { city: "Berlin" } },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  return stub;
}

function apiError(status: number) {
  return new APIError(status, { type: "error" }, `status ${status}`, undefined);
}

describe("AnthropicProvider resilience", () => {
  it("applies retry and timeout defaults to a client it builds itself", () => {
    const provider = new AnthropicProvider({
      model: "claude-sonnet-5",
      apiKey: "test-key",
    });

    const client = (provider as unknown as { client: Anthropic }).client;
    expect(client.maxRetries).toBe(DEFAULT_MAX_RETRIES);
    expect(client.timeout).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("passes explicit retry and timeout settings to a client it builds itself", () => {
    const provider = new AnthropicProvider({
      model: "claude-sonnet-5",
      apiKey: "test-key",
      maxRetries: 5,
      timeoutMs: 30_000,
    });

    const client = (provider as unknown as { client: Anthropic }).client;
    expect(client.maxRetries).toBe(5);
    expect(client.timeout).toBe(30_000);
  });

  it("leaves a supplied client's own transport policy alone", async () => {
    const { client, create } = toolUseClient();
    const provider = new AnthropicProvider({ model: "claude-sonnet-5", client });

    await provider.complete(call);

    expect(create.mock.calls[0][1]).toBeUndefined();
  });

  it("overrides a supplied client per call when asked to", async () => {
    const { client, create } = toolUseClient();
    const provider = new AnthropicProvider({
      model: "claude-sonnet-5",
      client,
      maxRetries: 4,
      timeoutMs: 15_000,
    });

    await provider.complete(call);

    expect(create.mock.calls[0][1]).toEqual({ maxRetries: 4, timeout: 15_000 });
  });
});

describe("AnthropicProvider errors", () => {
  it("marks an overloaded API as retryable", async () => {
    const { client } = rejectingClient(apiError(529));
    const provider = new AnthropicProvider({ model: "claude-sonnet-5", client });

    const error = await provider.complete(call).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AnthropicProviderError);
    expect(error).toMatchObject({ kind: "api", retryable: true, status: 529 });
  });

  it("marks a rate limit as retryable", async () => {
    const { client } = rejectingClient(apiError(429));
    const provider = new AnthropicProvider({ model: "claude-sonnet-5", client });

    await expect(provider.complete(call)).rejects.toMatchObject({
      kind: "api",
      retryable: true,
    });
  });

  it("marks a connection failure as retryable and keeps the SDK error as the cause", async () => {
    const cause = new APIConnectionError({ message: "socket hang up" });
    const { client } = rejectingClient(cause);
    const provider = new AnthropicProvider({ model: "claude-sonnet-5", client });

    const error = (await provider
      .complete(call)
      .catch((e: unknown) => e)) as AnthropicProviderError;

    expect(error.kind).toBe("api");
    expect(error.retryable).toBe(true);
    expect(error.cause).toBe(cause);
  });

  it("marks a bad request as not retryable", async () => {
    const { client } = rejectingClient(apiError(400));
    const provider = new AnthropicProvider({ model: "claude-sonnet-5", client });

    await expect(provider.complete(call)).rejects.toMatchObject({
      kind: "api",
      retryable: false,
      status: 400,
    });
  });

  it("types a truncated tool call and still names the token cap", async () => {
    const { client, create } = stubClient();
    create.mockResolvedValue({
      content: [{ type: "text", text: "partial" }],
      stop_reason: "max_tokens",
      usage: { input_tokens: 10, output_tokens: 64 },
    });
    const provider = new AnthropicProvider({
      model: "claude-sonnet-5",
      client,
      maxTokens: 64,
    });

    const error = (await provider
      .complete(call)
      .catch((e: unknown) => e)) as AnthropicProviderError;

    expect(error.kind).toBe("truncated");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("64-token output cap");
  });

  it("types a declined extraction as a content problem", async () => {
    const { client, create } = stubClient();
    create.mockResolvedValue({
      content: [{ type: "text", text: "I cannot help with that." }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const provider = new AnthropicProvider({ model: "claude-sonnet-5", client });

    const error = (await provider
      .complete(call)
      .catch((e: unknown) => e)) as AnthropicProviderError;

    expect(error.kind).toBe("no_output");
    expect(error.retryable).toBe(false);
    expect(error.stopReason).toBe("end_turn");
  });
});
