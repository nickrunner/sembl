import { describe, it, expect, vi } from "vitest";
import { OpenAIProvider } from "../openai-provider.js";
import type { RuntimeSchema, SchemaBundle } from "@sembl/core";

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

  it("resolves nested schemas from the request bundle", async () => {
    const profileSchema: RuntimeSchema = {
      id: "Profile",
      description: "A profile.",
      fields: [
        {
          name: "address",
          description: "Where they live",
          type: { kind: "object", nestedSchemaId: "Address" },
          required: true,
        },
      ],
    };
    const bundle: SchemaBundle = {
      schemas: { Address: testSchema, Profile: profileSchema },
    };

    const provider = new OpenAIProvider({ model: "gpt-4o", apiKey: "test-key" });
    const mockCreate = (provider as unknown as { client: { chat: { completions: { create: ReturnType<typeof vi.fn> } } } }).client.chat.completions.create;
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ address: { city: "Berlin", zip: null } }) } }],
    });

    await provider.complete({
      systemPrompt: "test",
      userInput: "test",
      jsonSchema: {},
      schema: profileSchema,
      bundle,
    });

    const sent = mockCreate.mock.calls[0][0].response_format.json_schema.schema;
    expect(Object.keys(sent.properties.address.properties)).toEqual(["city", "zip"]);
  });
});

describe("OpenAIProvider dynamic enums", () => {
  it("puts resolved enum values into the response_format schema", async () => {
    const provider = new OpenAIProvider({ model: "gpt-4o", apiKey: "test-key" });
    const mockCreate = (provider as unknown as { client: { chat: { completions: { create: ReturnType<typeof vi.fn> } } } }).client.chat.completions.create;
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ amenities: ["wifi"], kind: "cabin" }) } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    const schema: RuntimeSchema = {
      id: "Listing",
      description: "A listing.",
      fields: [
        {
          name: "amenities",
          description: "Amenities",
          type: { kind: "array", items: { kind: "dynamicEnum", sourceId: "amenities" } },
          required: true,
        },
        { name: "kind", description: "Kind", type: { kind: "dynamicEnum", sourceId: "kinds" }, required: true },
      ],
    };

    await provider.complete({
      systemPrompt: "sys",
      userInput: "in",
      jsonSchema: {},
      schema,
      resolvedEnums: { amenities: ["wifi", "hot-tub"], kinds: ["cabin", "flat"] },
    });

    const sent = mockCreate.mock.calls[0][0].response_format.json_schema.schema as {
      properties: { amenities: { items: { enum?: string[] } }; kind: { enum?: string[] } };
    };
    expect(sent.properties.amenities.items.enum).toEqual(["wifi", "hot-tub"]);
    expect(sent.properties.kind.enum).toEqual(["cabin", "flat"]);
  });
});

describe("OpenAIProvider history", () => {
  it("renders repair turns as assistant and user messages", async () => {
    const provider = new OpenAIProvider({ model: "gpt-4o", apiKey: "test-key" });
    expect(provider.supportsHistory).toBe(true);
    const mockCreate = (provider as unknown as { client: { chat: { completions: { create: ReturnType<typeof vi.fn> } } } }).client.chat.completions.create;
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ city: "Berlin", zip: null }) } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    await provider.complete({
      systemPrompt: "sys",
      userInput: "in",
      jsonSchema: {},
      schema: testSchema,
      history: [
        { role: "assistant", data: { city: 42 } },
        { role: "user", text: "city must be a string" },
      ],
    });

    expect(mockCreate.mock.calls[0][0].messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "in" },
      { role: "assistant", content: '{"city":42}' },
      { role: "user", content: "city must be a string" },
    ]);
  });
});
