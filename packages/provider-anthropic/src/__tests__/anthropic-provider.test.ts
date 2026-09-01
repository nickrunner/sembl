import { describe, it, expect, vi } from "vitest";
import { AnthropicProvider } from "../anthropic-provider.js";
import type { RuntimeSchema, SchemaBundle } from "@sembl/core";

const addressSchema: RuntimeSchema = {
  id: "Address",
  description: "A location.",
  fields: [
    { name: "city", description: "City", type: { kind: "string" }, required: true },
    { name: "zip", description: "Zip", type: { kind: "string" }, required: false },
  ],
};

/** Minimal stand-in for the pieces of the SDK client the provider touches. */
function mockClient(response: unknown) {
  const create = vi.fn().mockResolvedValue(response);
  return { client: { messages: { create } } as never, create };
}

function toolUseResponse(input: Record<string, unknown>, name = "extract_Address") {
  return {
    content: [
      { type: "text", text: "Let me extract that." },
      { type: "tool_use", id: "toolu_1", name, input },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 100, output_tokens: 20 },
  };
}

describe("AnthropicProvider", () => {
  it("forces the extraction tool and returns its parsed input", async () => {
    const { client, create } = mockClient(toolUseResponse({ city: "Berlin" }));
    const provider = new AnthropicProvider({ model: "claude-sonnet-5", client });

    const response = await provider.complete({
      systemPrompt: "You are a coercion engine.",
      userInput: "I live in Berlin",
      jsonSchema: {},
      schema: addressSchema,
    });

    expect(response.data).toEqual({ city: "Berlin" });
    expect(response.usage).toEqual({
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
    });

    const args = create.mock.calls[0][0];
    expect(args.model).toBe("claude-sonnet-5");
    expect(args.system).toBe("You are a coercion engine.");
    expect(args.messages).toEqual([{ role: "user", content: "I live in Berlin" }]);
    expect(args.tool_choice).toEqual({ type: "tool", name: "extract_Address" });
    expect(args.tools).toHaveLength(1);
    expect(args.tools[0].name).toBe("extract_Address");
    expect(args.tools[0].description).toBe("A location.");
    expect(args.tools[0].input_schema.required).toEqual(["city"]);
  });

  it("builds the tool schema from the bundle so nested objects keep their fields", async () => {
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
      schemas: { Address: addressSchema, Profile: profileSchema },
    };
    const { client, create } = mockClient(
      toolUseResponse({ address: { city: "Berlin" } }, "extract_Profile"),
    );
    const provider = new AnthropicProvider({ model: "claude-sonnet-5", client });

    await provider.complete({
      systemPrompt: "sys",
      userInput: "in",
      jsonSchema: {},
      schema: profileSchema,
      bundle,
    });

    const inputSchema = create.mock.calls[0][0].tools[0].input_schema;
    expect(Object.keys(inputSchema.properties.address.properties)).toEqual(["city", "zip"]);
  });

  it("defaults temperature to 0 and applies the max-token default", async () => {
    const { client, create } = mockClient(toolUseResponse({ city: "Berlin" }));
    const provider = new AnthropicProvider({ model: "claude-sonnet-5", client });

    await provider.complete({
      systemPrompt: "sys",
      userInput: "in",
      jsonSchema: {},
      schema: addressSchema,
    });

    expect(create.mock.calls[0][0].temperature).toBe(0);
    expect(create.mock.calls[0][0].max_tokens).toBe(4096);
  });

  it("honours an explicit tool name", async () => {
    const { client, create } = mockClient(toolUseResponse({ city: "Berlin" }, "prefill_stay"));
    const provider = new AnthropicProvider({
      model: "claude-sonnet-5",
      client,
      toolName: "prefill_stay",
    });

    await provider.complete({
      systemPrompt: "sys",
      userInput: "in",
      jsonSchema: {},
      schema: addressSchema,
    });

    expect(create.mock.calls[0][0].tool_choice).toEqual({
      type: "tool",
      name: "prefill_stay",
    });
  });

  it("explains a truncated tool call rather than reporting a missing one", async () => {
    const { client } = mockClient({
      content: [{ type: "text", text: "partial" }],
      stop_reason: "max_tokens",
      usage: { input_tokens: 10, output_tokens: 64 },
    });
    const provider = new AnthropicProvider({
      model: "claude-sonnet-5",
      client,
      maxTokens: 64,
    });

    await expect(
      provider.complete({
        systemPrompt: "sys",
        userInput: "in",
        jsonSchema: {},
        schema: addressSchema,
      }),
    ).rejects.toThrow("64-token output cap");
  });

  it("throws when the model answers without calling the tool", async () => {
    const { client } = mockClient({
      content: [{ type: "text", text: "I cannot help with that." }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const provider = new AnthropicProvider({ model: "claude-sonnet-5", client });

    await expect(
      provider.complete({
        systemPrompt: "sys",
        userInput: "in",
        jsonSchema: {},
        schema: addressSchema,
      }),
    ).rejects.toThrow("no \"extract_Address\" tool call");
  });
});
