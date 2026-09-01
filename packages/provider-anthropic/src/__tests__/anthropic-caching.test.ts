import { describe, it, expect, vi } from "vitest";
import { AnthropicProvider } from "../anthropic-provider.js";
import type { RuntimeSchema } from "@sembl/core";

const addressSchema: RuntimeSchema = {
  id: "Address",
  description: "A location.",
  fields: [
    { name: "city", description: "City", type: { kind: "string" }, required: true },
  ],
};

/** Minimal stand-in for the pieces of the SDK client the provider touches. */
function mockClient(usage: Record<string, unknown>) {
  const create = vi.fn().mockResolvedValue({
    content: [{ type: "tool_use", id: "toolu_1", name: "extract_Address", input: { city: "Berlin" } }],
    stop_reason: "tool_use",
    usage: { input_tokens: 100, output_tokens: 20, ...usage },
  });
  return { client: { messages: { create } } as never, create };
}

const call = {
  systemPrompt: "You are a coercion engine.",
  userInput: "I live in Berlin",
  jsonSchema: {},
  schema: addressSchema,
};

describe("AnthropicProvider prompt caching", () => {
  it("sends the system prompt as a plain string when caching is off", async () => {
    const { client, create } = mockClient({});
    const provider = new AnthropicProvider({ model: "claude-sonnet-5", client });

    await provider.complete(call);

    expect(create.mock.calls[0][0].system).toBe("You are a coercion engine.");
  });

  it("marks the system block as a cache breakpoint, covering the tool definition", async () => {
    const { client, create } = mockClient({});
    const provider = new AnthropicProvider({
      model: "claude-sonnet-5",
      client,
      cachePrompt: true,
    });

    await provider.complete(call);

    const args = create.mock.calls[0][0];
    expect(args.system).toEqual([
      {
        type: "text",
        text: "You are a coercion engine.",
        cache_control: { type: "ephemeral", ttl: "5m" },
      },
    ]);
    // The one thing that varies between calls must stay after the breakpoint.
    expect(args.messages).toEqual([{ role: "user", content: "I live in Berlin" }]);
    expect(args.tools[0].cache_control).toBeUndefined();
  });

  it("honours an explicit cache TTL", async () => {
    const { client, create } = mockClient({});
    const provider = new AnthropicProvider({
      model: "claude-sonnet-5",
      client,
      cachePrompt: true,
      cacheTtl: "1h",
    });

    await provider.complete(call);

    expect(create.mock.calls[0][0].system[0].cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
  });

  it("keeps the prefix byte-identical across calls that differ only in input", async () => {
    const { client, create } = mockClient({});
    const provider = new AnthropicProvider({
      model: "claude-sonnet-5",
      client,
      cachePrompt: true,
    });

    await provider.complete(call);
    await provider.complete({ ...call, userInput: "I live in Hamburg" });

    const [first, second] = create.mock.calls.map((c) => c[0]);
    expect(JSON.stringify(second.system)).toBe(JSON.stringify(first.system));
    expect(JSON.stringify(second.tools)).toBe(JSON.stringify(first.tools));
  });

  it("reports cache writes and reads in usage", async () => {
    const { client } = mockClient({
      cache_creation_input_tokens: 1800,
      cache_read_input_tokens: 0,
    });
    const provider = new AnthropicProvider({
      model: "claude-sonnet-5",
      client,
      cachePrompt: true,
    });

    const write = await provider.complete(call);
    expect(write.usage).toEqual({
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      cacheWriteTokens: 1800,
      cacheReadTokens: 0,
    });

    const { client: readClient } = mockClient({
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 1800,
    });
    const readProvider = new AnthropicProvider({
      model: "claude-sonnet-5",
      client: readClient,
      cachePrompt: true,
    });

    const read = await readProvider.complete(call);
    expect(read.usage?.cacheReadTokens).toBe(1800);
  });

  it("omits the cache fields when the API reports none", async () => {
    const { client } = mockClient({
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
    });
    const provider = new AnthropicProvider({ model: "claude-sonnet-5", client });

    const response = await provider.complete(call);

    expect(response.usage).not.toHaveProperty("cacheWriteTokens");
    expect(response.usage).not.toHaveProperty("cacheReadTokens");
  });
});
