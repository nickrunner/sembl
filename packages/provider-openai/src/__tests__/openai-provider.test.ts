import { describe, it, expect, vi } from "vitest";
import { OpenAIProvider } from "../openai-provider.js";
import type { RuntimeSchema } from "@sembl/core";

// Mock the openai module
vi.mock("openai", () => {
  return {
    default: class MockOpenAI {
      chat = {
        completions: {
          create: vi.fn(),
        },
      };

      constructor(_config: Record<string, unknown>) {}
    },
  };
});

const testSchema: RuntimeSchema = {
  id: "Address",
  description: "A location.",
  fields: [
    { name: "city", description: "City", type: { kind: "string" }, required: true },
    { name: "zip", description: "Zip", type: { kind: "string" }, required: false },
  ],
};

describe("OpenAIProvider", () => {
  it("sends structured output request and parses response", async () => {
    const provider = new OpenAIProvider({
      model: "gpt-4o",
      apiKey: "test-key",
    });

    // Access the mocked create function
    const mockCreate = (provider as unknown as { client: { chat: { completions: { create: ReturnType<typeof vi.fn> } } } }).client.chat.completions.create;
    mockCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({ city: "Berlin", zip: null }),
          },
        },
      ],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
      },
    });

    const response = await provider.complete({
      systemPrompt: "You are a coercion engine.",
      userInput: "I live in Berlin",
      jsonSchema: {},
      schema: testSchema,
    });

    expect(response.data).toEqual({ city: "Berlin", zip: null });
    expect(response.usage).toEqual({
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
    });
  });

  it("throws when response has no content", async () => {
    const provider = new OpenAIProvider({
      model: "gpt-4o",
      apiKey: "test-key",
    });

    const mockCreate = (provider as unknown as { client: { chat: { completions: { create: ReturnType<typeof vi.fn> } } } }).client.chat.completions.create;
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: null } }],
    });

    await expect(
      provider.complete({
        systemPrompt: "test",
        userInput: "test",
        jsonSchema: {},
        schema: testSchema,
      }),
    ).rejects.toThrow("no content");
  });
});
