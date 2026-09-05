import { describe, it, expect, vi } from "vitest";
import { AnthropicProvider } from "../anthropic-provider.js";
import type { ContentBlock, RuntimeSchema } from "@sembl/core";

const schema: RuntimeSchema = {
  id: "Listing",
  description: "A listing.",
  fields: [{ name: "name", description: "Name", type: { kind: "string" }, required: true }],
};

function mockClient() {
  const create = vi.fn().mockResolvedValue({
    content: [{ type: "tool_use", id: "toolu_1", name: "extract_Listing", input: { name: "Sea Cabin" } }],
    stop_reason: "tool_use",
    usage: { input_tokens: 10, output_tokens: 2 },
  });
  return { client: { messages: { create } } as never, create };
}

const bytes = new Uint8Array([104, 105]);
const content: ContentBlock[] = [
  { type: "text", text: '<source label="Photo" type="image/png">\n' },
  { type: "image", label: "Photo", source: { data: bytes, mediaType: "image/png" } },
  { type: "text", text: '\n</source>\n\n<source label="Remote" type="image">\n' },
  { type: "image", label: "Remote", source: { url: "https://example.test/a.jpg" } },
  { type: "text", text: '\n</source>\n\n<source label="Scan" type="application/pdf">\n' },
  { type: "document", label: "Scan", source: { data: "JVBERi0=", mediaType: "application/pdf" } },
  { type: "text", text: '\n</source>\n\n<source type="document">\n' },
  { type: "document", source: { url: "https://example.test/b.pdf" } },
  { type: "text", text: "\n</source>" },
];

describe("AnthropicProvider images and documents", () => {
  it("declares support for both", () => {
    const provider = new AnthropicProvider({ model: "claude-sonnet-5", client: mockClient().client });
    expect(provider.supportsImages).toBe(true);
    expect(provider.supportsDocuments).toBe(true);
  });

  it("renders content blocks as the API's image and document blocks in one user message", async () => {
    const { client, create } = mockClient();
    const provider = new AnthropicProvider({ model: "claude-sonnet-5", client });
    const response = await provider.complete({
      systemPrompt: "sys",
      userInput: "placeholder rendering",
      content,
      jsonSchema: {},
      schema,
    });
    expect(response.data).toEqual({ name: "Sea Cabin" });

    const messages = create.mock.calls[0][0].messages;
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toEqual([
      { type: "text", text: '<source label="Photo" type="image/png">\n' },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "aGk=" } },
      { type: "text", text: '\n</source>\n\n<source label="Remote" type="image">\n' },
      { type: "image", source: { type: "url", url: "https://example.test/a.jpg" } },
      { type: "text", text: '\n</source>\n\n<source label="Scan" type="application/pdf">\n' },
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" }, title: "Scan" },
      { type: "text", text: '\n</source>\n\n<source type="document">\n' },
      { type: "document", source: { type: "url", url: "https://example.test/b.pdf" } },
      { type: "text", text: "\n</source>" },
    ]);
  });

  it("still sends a plain string when there is no content", async () => {
    const { client, create } = mockClient();
    const provider = new AnthropicProvider({ model: "claude-sonnet-5", client });
    await provider.complete({ systemPrompt: "sys", userInput: "in", jsonSchema: {}, schema });
    expect(create.mock.calls[0][0].messages).toEqual([{ role: "user", content: "in" }]);
  });

  it("keeps repair history after a multimodal first turn", async () => {
    const { client, create } = mockClient();
    const provider = new AnthropicProvider({ model: "claude-sonnet-5", client });
    await provider.complete({
      systemPrompt: "sys",
      userInput: "in",
      content: content.slice(0, 3),
      jsonSchema: {},
      schema,
      history: [
        { role: "assistant", data: { name: 1 } },
        { role: "user", text: "name must be a string" },
      ],
    });
    const messages = create.mock.calls[0][0].messages;
    expect(messages).toHaveLength(3);
    expect(Array.isArray(messages[0].content)).toBe(true);
    expect(messages[1].content[0]).toMatchObject({ type: "tool_use", input: { name: 1 } });
    expect(messages[2].content[0]).toMatchObject({ type: "tool_result", is_error: true });
  });
});
