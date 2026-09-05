import { describe, it, expect, vi } from "vitest";
import { OpenAIProvider } from "../openai-provider.js";
import type { ContentBlock, RuntimeSchema } from "@sembl/core";

vi.mock("openai", () => {
  return {
    default: class MockOpenAI {
      chat = { completions: { create: vi.fn() } };
      constructor(_config: Record<string, unknown>) {}
    },
  };
});

const schema: RuntimeSchema = {
  id: "Listing",
  description: "A listing.",
  fields: [{ name: "name", description: "Name", type: { kind: "string" }, required: true }],
};

function providerWithMock() {
  const provider = new OpenAIProvider({ model: "gpt-4o", apiKey: "test-key" });
  const create = (provider as unknown as { client: { chat: { completions: { create: ReturnType<typeof vi.fn> } } } })
    .client.chat.completions.create;
  create.mockResolvedValue({
    choices: [{ message: { content: JSON.stringify({ name: "Sea Cabin" }) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  });
  return { provider, create };
}

const bytes = new Uint8Array([104, 105]);

describe("OpenAIProvider images and documents", () => {
  it("declares support for both", () => {
    const { provider } = providerWithMock();
    expect(provider.supportsImages).toBe(true);
    expect(provider.supportsDocuments).toBe(true);
  });

  it("renders images as image_url parts and inline PDFs as file parts", async () => {
    const { provider, create } = providerWithMock();
    const content: ContentBlock[] = [
      { type: "text", text: '<source label="Photo" type="image/png">\n' },
      { type: "image", label: "Photo", source: { data: bytes, mediaType: "image/png" } },
      { type: "text", text: '\n</source>\n\n<source label="Remote" type="image">\n' },
      { type: "image", label: "Remote", source: { url: "https://example.test/a.jpg" } },
      { type: "text", text: '\n</source>\n\n<source label="Broker scan 2" type="application/pdf">\n' },
      { type: "document", label: "Broker scan 2", source: { data: "JVBERi0=", mediaType: "application/pdf" } },
      { type: "text", text: "\n</source>" },
    ];
    const response = await provider.complete({ systemPrompt: "sys", userInput: "placeholder", content, jsonSchema: {}, schema });
    expect(response.data).toEqual({ name: "Sea Cabin" });

    const messages = create.mock.calls[0][0].messages;
    expect(messages[0]).toEqual({ role: "system", content: "sys" });
    expect(messages[1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: '<source label="Photo" type="image/png">\n' },
        { type: "image_url", image_url: { url: "data:image/png;base64,aGk=" } },
        { type: "text", text: '\n</source>\n\n<source label="Remote" type="image">\n' },
        { type: "image_url", image_url: { url: "https://example.test/a.jpg" } },
        { type: "text", text: '\n</source>\n\n<source label="Broker scan 2" type="application/pdf">\n' },
        { type: "file", file: { filename: "Broker_scan_2.pdf", file_data: "data:application/pdf;base64,JVBERi0=" } },
        { type: "text", text: "\n</source>" },
      ],
    });
  });

  it("names an unlabelled document generically", async () => {
    const { provider, create } = providerWithMock();
    await provider.complete({
      systemPrompt: "sys",
      userInput: "p",
      content: [{ type: "document", source: { data: bytes, mediaType: "application/pdf" } }],
      jsonSchema: {},
      schema,
    });
    expect(create.mock.calls[0][0].messages[1].content[0].file.filename).toBe("document.pdf");
  });

  it("refuses a document given by URL before calling, since chat completions have no URL form", async () => {
    const { provider, create } = providerWithMock();
    await expect(
      provider.complete({
        systemPrompt: "sys",
        userInput: "p",
        content: [{ type: "document", label: "Scan", source: { url: "https://example.test/b.pdf" } }],
        jsonSchema: {},
        schema,
      }),
    ).rejects.toThrow(/take a PDF only as bytes, not by URL \(source "Scan"\)/);
    expect(create).not.toHaveBeenCalled();
  });

  it("still sends a plain string when there is no content, with history after it", async () => {
    const { provider, create } = providerWithMock();
    await provider.complete({
      systemPrompt: "sys",
      userInput: "in",
      jsonSchema: {},
      schema,
      history: [{ role: "assistant", data: { name: 1 } }, { role: "user", text: "fix" }],
    });
    const messages = create.mock.calls[0][0].messages;
    expect(messages[1]).toEqual({ role: "user", content: "in" });
    expect(messages[2]).toEqual({ role: "assistant", content: '{"name":1}' });
    expect(messages[3]).toEqual({ role: "user", content: "fix" });
  });
});
