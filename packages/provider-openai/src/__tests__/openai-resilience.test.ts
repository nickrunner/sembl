import { describe, it, expect, vi } from "vitest";
import { APIConnectionError, APIError } from "openai";
import { OpenAIProvider } from "../openai-provider.js";
import { OpenAIProviderError } from "../errors.js";
import { DEFAULT_MAX_RETRIES, DEFAULT_TIMEOUT_MS } from "../openai-config.js";
import type { RuntimeSchema } from "@sembl/core";

// Only the client is faked: the SDK's real error classes stay in place, since
// the provider branches on them to decide what is retryable.
vi.mock("openai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openai")>();
  return {
    ...actual,
    default: class MockOpenAI {
      options: Record<string, unknown>;
      chat = { completions: { create: vi.fn() } };

      constructor(options: Record<string, unknown>) {
        this.options = options;
      }
    },
  };
});

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

type FakeClient = {
  options: Record<string, unknown>;
  chat: { completions: { create: ReturnType<typeof vi.fn> } };
};

function fakeClient(provider: OpenAIProvider): FakeClient {
  return (provider as unknown as { client: FakeClient }).client;
}

function apiError(status: number) {
  return new APIError(status, { type: "error" }, `status ${status}`, undefined);
}

describe("OpenAIProvider resilience", () => {
  it("applies retry and timeout defaults", () => {
    const provider = new OpenAIProvider({ model: "gpt-4o", apiKey: "k" });

    expect(fakeClient(provider).options).toMatchObject({
      maxRetries: DEFAULT_MAX_RETRIES,
      timeout: DEFAULT_TIMEOUT_MS,
    });
  });

  it("passes explicit retry and timeout settings through", () => {
    const provider = new OpenAIProvider({
      model: "gpt-4o",
      apiKey: "k",
      maxRetries: 5,
      timeoutMs: 30_000,
    });

    expect(fakeClient(provider).options).toMatchObject({
      maxRetries: 5,
      timeout: 30_000,
    });
  });
});

describe("OpenAIProvider errors", () => {
  it("marks a rate limit as retryable", async () => {
    const provider = new OpenAIProvider({ model: "gpt-4o", apiKey: "k" });
    fakeClient(provider).chat.completions.create.mockRejectedValue(apiError(429));

    const error = await provider.complete(call).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OpenAIProviderError);
    expect(error).toMatchObject({ kind: "api", retryable: true, status: 429 });
  });

  it("marks a connection failure as retryable and keeps the SDK error as the cause", async () => {
    const cause = new APIConnectionError({ message: "socket hang up" });
    const provider = new OpenAIProvider({ model: "gpt-4o", apiKey: "k" });
    fakeClient(provider).chat.completions.create.mockRejectedValue(cause);

    const error = (await provider
      .complete(call)
      .catch((e: unknown) => e)) as OpenAIProviderError;

    expect(error.retryable).toBe(true);
    expect(error.cause).toBe(cause);
  });

  it("marks a bad request as not retryable", async () => {
    const provider = new OpenAIProvider({ model: "gpt-4o", apiKey: "k" });
    fakeClient(provider).chat.completions.create.mockRejectedValue(apiError(400));

    await expect(provider.complete(call)).rejects.toMatchObject({
      kind: "api",
      retryable: false,
    });
  });

  it("names the token cap when the response was truncated", async () => {
    const provider = new OpenAIProvider({
      model: "gpt-4o",
      apiKey: "k",
      maxTokens: 64,
    });
    fakeClient(provider).chat.completions.create.mockResolvedValue({
      choices: [{ finish_reason: "length", message: { content: '{"city":"Ber' } }],
    });

    const error = (await provider
      .complete(call)
      .catch((e: unknown) => e)) as OpenAIProviderError;

    expect(error.kind).toBe("truncated");
    expect(error.message).toContain("64-token output cap");
  });

  it("types a refusal as a content problem", async () => {
    const provider = new OpenAIProvider({ model: "gpt-4o", apiKey: "k" });
    fakeClient(provider).chat.completions.create.mockResolvedValue({
      choices: [
        {
          finish_reason: "stop",
          message: { content: null, refusal: "I can't help with that." },
        },
      ],
    });

    const error = (await provider
      .complete(call)
      .catch((e: unknown) => e)) as OpenAIProviderError;

    expect(error.kind).toBe("no_output");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("I can't help with that.");
  });

  it("types unparseable content as a content problem", async () => {
    const provider = new OpenAIProvider({ model: "gpt-4o", apiKey: "k" });
    fakeClient(provider).chat.completions.create.mockResolvedValue({
      choices: [{ finish_reason: "stop", message: { content: "not json" } }],
    });

    await expect(provider.complete(call)).rejects.toMatchObject({
      kind: "no_output",
    });
  });

  it("reports cached prompt tokens when the API sends them", async () => {
    const provider = new OpenAIProvider({ model: "gpt-4o", apiKey: "k" });
    fakeClient(provider).chat.completions.create.mockResolvedValue({
      choices: [
        { finish_reason: "stop", message: { content: '{"city":"Berlin"}' } },
      ],
      usage: {
        prompt_tokens: 2000,
        completion_tokens: 20,
        total_tokens: 2020,
        prompt_tokens_details: { cached_tokens: 1792 },
      },
    });

    const response = await provider.complete(call);

    expect(response.usage).toEqual({
      promptTokens: 2000,
      completionTokens: 20,
      totalTokens: 2020,
      cacheReadTokens: 1792,
    });
  });
});
