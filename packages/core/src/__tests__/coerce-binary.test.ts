import { describe, it, expect } from "vitest";
import { coerce, partialCoerce, partialCoerceWithProvenance, primeCache } from "../coerce/coerce.js";
import { coerceMany } from "../coerce/coerce-many.js";
import { sembl } from "../coerce/coercible.js";
import { SemblConfig } from "../coerce/config.js";
import { BINARY_PROVENANCE_INSTRUCTIONS } from "../coerce/provenance.js";
import { BINARY_SOURCE_INSTRUCTIONS } from "../coerce/sources.js";
import type { DocumentSource, ImageSource } from "../coerce/sources.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../provider/types.js";
import type { RuntimeSchema } from "../schema/types.js";
import type { TraceSink, TraceSpan } from "../tracing/types.js";

const nameSchema: RuntimeSchema = {
  id: "Person",
  description: "A person.",
  fields: [{ name: "name", description: "Name", type: { kind: "string" }, required: true }],
};

const photo: ImageSource = { label: "Photo", image: { data: new Uint8Array([1, 2, 3]), mediaType: "image/png" } };
const scan: DocumentSource = { label: "Scan", document: { url: "https://example.test/scan.pdf" } };

/** A provider that records every request and answers each with `responses` in turn. */
function capturingProvider(
  responses: Record<string, unknown>[] = [{ name: "Ada" }],
  capabilities: Pick<Provider, "supportsImages" | "supportsDocuments" | "supportsHistory"> = {
    supportsImages: true,
    supportsDocuments: true,
  },
) {
  const requests: ProviderRequest[] = [];
  let call = 0;
  const provider: Provider = {
    ...capabilities,
    async complete(request: ProviderRequest): Promise<ProviderResponse> {
      requests.push(request);
      const data = responses[Math.min(call, responses.length - 1)];
      call += 1;
      return { data, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } };
    },
  };
  return { provider, requests };
}

function collectEvents() {
  const events: { name: string; attributes: Record<string, unknown> }[] = [];
  const sink: TraceSink = {
    write(span: TraceSpan) {
      for (const event of span.events) events.push({ name: event.name, attributes: event.attributes ?? {} });
    },
  };
  return { sink, events };
}

describe("coerce with binary sources", () => {
  it("sends content blocks alongside the text rendering", async () => {
    const { provider, requests } = capturingProvider();
    await coerce([{ label: "Email", text: "Ada" }, photo], { provider, schema: nameSchema });
    const [request] = requests;
    expect(request.userInput).toBe('<source label="Email">\nAda\n</source>\n\n<source label="Photo" type="image/png" />');
    expect(request.content).toEqual([
      { type: "text", text: '<source label="Email">\nAda\n</source>\n\n<source label="Photo" type="image/png">\n' },
      { type: "image", label: "Photo", source: photo.image },
      { type: "text", text: "\n</source>" },
    ]);
  });

  it("sends no content for text-only input, so text requests are unchanged", async () => {
    const { provider, requests } = capturingProvider();
    await coerce("Ada", { provider, schema: nameSchema });
    expect("content" in requests[0]).toBe(false);
    expect(requests[0].systemPrompt).not.toContain(BINARY_SOURCE_INSTRUCTIONS);
  });

  it("adds the binary source rules to the system prompt only when needed", async () => {
    const { provider, requests } = capturingProvider();
    await coerce(photo, { provider, schema: nameSchema });
    expect(requests[0].systemPrompt).toContain(BINARY_SOURCE_INSTRUCTIONS);
  });

  it("treats a lone image as input that can be retried when the answer is empty", async () => {
    const { provider, requests } = capturingProvider([{ name: null }, { name: "Ada" }]);
    const result = await partialCoerce<{ name: string }>(photo, { provider, schema: nameSchema, retryOnEmpty: 1 });
    expect(result).toEqual({ name: "Ada" });
    expect(requests).toHaveLength(2);
  });

  it("records image and document counts in the inputRendered event", async () => {
    const { provider } = capturingProvider();
    const { sink, events } = collectEvents();
    await coerce([photo, scan, { text: "x" }], { provider, schema: nameSchema, traceSinks: [sink] });
    const event = events.find((e) => e.name === "inputRendered");
    expect(event?.attributes).toMatchObject({ sourceCount: 3, imageCount: 1, documentCount: 1 });
  });

  it("keeps the inputRendered event unchanged for text input", async () => {
    const { provider } = capturingProvider();
    const { sink, events } = collectEvents();
    await coerce("x", { provider, schema: nameSchema, traceSinks: [sink] });
    const event = events.find((e) => e.name === "inputRendered");
    expect(Object.keys(event?.attributes ?? {}).sort()).toEqual(["inputLength", "sourceCount"]);
  });
});

describe("provider support", () => {
  it("refuses an image for a provider that does not declare supportsImages", async () => {
    const { provider, requests } = capturingProvider([{ name: "Ada" }], {});
    await expect(coerce(photo, { provider, schema: nameSchema })).rejects.toThrow(
      /Source "Photo" is an image, but the provider does not declare supportsImages/,
    );
    await expect(coerce(photo, { provider, schema: nameSchema })).rejects.toThrow(RangeError);
    expect(requests).toHaveLength(0);
  });

  it("refuses a document for a provider that only supports images", async () => {
    const { provider, requests } = capturingProvider([{ name: "Ada" }], { supportsImages: true });
    await expect(coerce([{ text: "t" }, scan], { provider, schema: nameSchema })).rejects.toThrow(
      /Source "Scan" is a document, but the provider does not declare supportsDocuments/,
    );
    expect(requests).toHaveLength(0);
  });

  it("names an unlabelled source generically", async () => {
    const { provider } = capturingProvider([{ name: "Ada" }], {});
    await expect(coerce({ image: photo.image }, { provider, schema: nameSchema })).rejects.toThrow(
      /^The source is an image/,
    );
  });

  it("does not call the enum resolver before refusing", async () => {
    const { provider } = capturingProvider([{ name: "Ada" }], {});
    const schema: RuntimeSchema = {
      id: "Tagged",
      description: "Tagged.",
      fields: [{ name: "tag", description: "Tag", type: { kind: "dynamicEnum", sourceId: "tags" }, required: false }],
    };
    let resolved = 0;
    await expect(
      coerce(photo, {
        provider,
        schema,
        enumResolver: async () => {
          resolved += 1;
          return ["a"];
        },
      }),
    ).rejects.toThrow(RangeError);
    expect(resolved).toBe(0);
  });

  it("lets an image through once maxImages has dropped it", async () => {
    const { provider, requests } = capturingProvider([{ name: "Ada" }], {});
    await coerce([{ text: "Ada" }, photo], { provider, schema: nameSchema, maxImages: 0 });
    expect(requests[0].userInput).toBe('<source label="Source 1">\nAda\n</source>');
    expect("content" in requests[0]).toBe(false);
  });
});

describe("maxImages and maxDocuments", () => {
  it("rejects a negative or fractional cap before any call", async () => {
    const { provider, requests } = capturingProvider();
    await expect(coerce(photo, { provider, schema: nameSchema, maxImages: -1 })).rejects.toThrow(RangeError);
    await expect(coerce(photo, { provider, schema: nameSchema, maxDocuments: 1.5 })).rejects.toThrow(
      /maxDocuments must be a non-negative integer/,
    );
    expect(requests).toHaveLength(0);
  });

  it("drops extras from the end and records a sourcesDropped event", async () => {
    const { provider, requests } = capturingProvider();
    const { sink, events } = collectEvents();
    const second: ImageSource = { label: "Second", image: { url: "https://example.test/2.png" } };
    const third: ImageSource = { label: "Third", image: { url: "https://example.test/3.png" } };
    await coerce([photo, second, scan, third], {
      provider,
      schema: nameSchema,
      maxImages: 2,
      maxDocuments: 1,
      traceSinks: [sink],
    });
    expect(requests[0].userInput).toBe(
      '<source label="Photo" type="image/png" />\n\n<source label="Second" type="image" />\n\n<source label="Scan" type="document" />',
    );
    const event = events.find((e) => e.name === "sourcesDropped");
    expect(event?.attributes).toEqual({
      maxImages: 2,
      maxDocuments: 1,
      sources: [{ label: "Third", kind: "image", index: 3 }],
    });
  });

  it("records nothing when every source fits", async () => {
    const { provider } = capturingProvider();
    const { sink, events } = collectEvents();
    await coerce([photo, scan], { provider, schema: nameSchema, maxImages: 5, traceSinks: [sink] });
    expect(events.some((e) => e.name === "sourcesDropped")).toBe(false);
  });

  it("combines with maxInputChars, which still touches only text", async () => {
    const { provider, requests } = capturingProvider();
    const { sink, events } = collectEvents();
    await coerce([{ text: "a".repeat(2000) }, photo, photo], {
      provider,
      schema: nameSchema,
      maxImages: 1,
      maxInputChars: 200,
      traceSinks: [sink],
    });
    expect(requests[0].userInput).toContain("characters omitted");
    expect(requests[0].content?.filter((b) => b.type === "image")).toHaveLength(1);
    expect(events.map((e) => e.name)).toEqual(expect.arrayContaining(["sourcesDropped", "inputTruncated"]));
  });

  it("flow through sembl() config and global config", async () => {
    const { provider, requests } = capturingProvider();
    SemblConfig.configure({ provider, maxImages: 0 });
    try {
      await sembl([{ text: "Ada" }, photo]).coerceTo(nameSchema);
      expect("content" in requests[0]).toBe(false);
      await sembl([{ text: "Ada" }, photo], { maxImages: 1 }).coerceTo(nameSchema);
      expect(requests[1].content?.some((b) => b.type === "image")).toBe(true);
    } finally {
      SemblConfig.reset();
    }
  });
});

describe("preprocess with binary sources", () => {
  it("is offered only the text sources, with their original indexes", async () => {
    const { provider, requests } = capturingProvider();
    const seen: number[] = [];
    await coerce([photo, { text: "raw" }, scan], {
      provider,
      schema: nameSchema,
      preprocess: (source, index) => {
        seen.push(index);
        return source.text.toUpperCase();
      },
    });
    expect(seen).toEqual([1]);
    expect(requests[0].userInput).toContain('<source label="Source 2">\nRAW\n</source>');
    expect(requests[0].content?.filter((b) => b.type !== "text").map((b) => b.type)).toEqual(["image", "document"]);
  });
});

describe("repair and empty-retry follow-ups with content", () => {
  it("appends the folded correction to the last text block for a single-turn provider", async () => {
    const { provider, requests } = capturingProvider([{ name: 42 }, { name: "Ada" }], {
      supportsImages: true,
      supportsDocuments: true,
      supportsHistory: false,
    });
    await coerce(photo, { provider, schema: nameSchema, maxRepairAttempts: 1 });
    expect(requests).toHaveLength(2);
    const repair = requests[1];
    expect(repair.userInput.startsWith('<source label="Photo" type="image/png" />\n\n---\n\nA previous attempt')).toBe(true);
    expect(repair.content?.[1]).toEqual({ type: "image", label: "Photo", source: photo.image });
    const last = repair.content?.[repair.content.length - 1];
    expect(last?.type).toBe("text");
    expect(last?.type === "text" && last.text.startsWith("\n</source>\n\n---\n\nA previous attempt")).toBe(true);
    expect(repair.content).toHaveLength(3);
  });

  it("leaves content untouched and uses history for a multi-turn provider", async () => {
    const { provider, requests } = capturingProvider([{ name: 42 }, { name: "Ada" }], {
      supportsImages: true,
      supportsDocuments: true,
      supportsHistory: true,
    });
    await coerce(photo, { provider, schema: nameSchema, maxRepairAttempts: 1 });
    const repair = requests[1];
    expect(repair.content).toEqual(requests[0].content);
    expect(repair.history).toHaveLength(2);
  });

  it("folds the empty-retry note into the content as well", async () => {
    const { provider, requests } = capturingProvider([{ name: null }, { name: "Ada" }], {
      supportsImages: true,
      supportsHistory: false,
    });
    await partialCoerce(photo, { provider, schema: nameSchema, retryOnEmpty: 1 });
    const retry = requests[1];
    const last = retry.content?.[retry.content.length - 1];
    expect(last?.type === "text" && last.text).toContain("A previous attempt at this extraction returned no fields");
    expect(retry.userInput.endsWith(last?.type === "text" ? last.text.slice("\n</source>".length) : "!")).toBe(true);
  });
});

describe("provenance with binary sources", () => {
  it("adds the image evidence rule and adjusts the evidence field description", async () => {
    const { provider, requests } = capturingProvider([{ name: { value: "Ada", confidence: "high", evidence: "the name on the badge" } }]);
    const { data, provenance } = await partialCoerceWithProvenance<{ name: string }>(photo, { provider, schema: nameSchema });
    expect(data).toEqual({ name: "Ada" });
    expect(provenance.name).toEqual({ confidence: "high", evidence: "the name on the badge" });
    expect(requests[0].systemPrompt).toContain(BINARY_PROVENANCE_INSTRUCTIONS);
    expect(JSON.stringify(requests[0].jsonSchema)).toContain("where in it the value appears");
  });

  it("keeps the text-only provenance prompt and schema unchanged", async () => {
    const { provider, requests } = capturingProvider([{ name: { value: "Ada", confidence: "high" } }]);
    await partialCoerceWithProvenance(" Ada ", { provider, schema: nameSchema });
    expect(requests[0].systemPrompt).not.toContain(BINARY_PROVENANCE_INSTRUCTIONS);
    const serialized = JSON.stringify(requests[0].jsonSchema);
    expect(serialized).toContain(
      "The shortest quote from the input this value was read from. Omit when the value was inferred rather than read.",
    );
    expect(serialized).not.toContain("where in it the value appears");
  });
});

describe("primeCache with sourceKinds", () => {
  it("warms the binary prefix when asked, and the text prefix by default", async () => {
    const { provider, requests } = capturingProvider();
    await primeCache({ provider, schema: nameSchema });
    await primeCache({ provider, schema: nameSchema, sourceKinds: ["text", "image"] });
    expect(requests[0].systemPrompt).not.toContain(BINARY_SOURCE_INSTRUCTIONS);
    expect(requests[1].systemPrompt).toContain(BINARY_SOURCE_INSTRUCTIONS);
    // The warm-up input is text, so it never carries blocks.
    expect("content" in requests[1]).toBe(false);
  });
});

describe("coerceMany with binary sources", () => {
  it("stamps itemLabel from an image or document source and honours the caps per item", async () => {
    const { provider, requests } = capturingProvider();
    const spans: { name: string; attributes?: Record<string, unknown> }[] = [];
    const results = await coerceMany<{ name: string }>(
      [photo, [scan, photo], { image: { url: "https://example.test/3.png" } }],
      {
        provider,
        schema: nameSchema,
        primeCache: false,
        maxImages: 1,
        traceSinks: [{ write: (span) => spans.push({ name: span.name, attributes: span.attributes }) }],
      },
    );
    expect(results.every((r) => r.ok)).toBe(true);
    const calls = spans.filter((s) => s.name === "llmCall");
    expect(calls.find((s) => s.attributes?.itemIndex === 0)?.attributes?.itemLabel).toBe("Photo");
    expect(calls.find((s) => s.attributes?.itemIndex === 1)?.attributes?.itemLabel).toBe("Scan");
    expect("itemLabel" in (calls.find((s) => s.attributes?.itemIndex === 2)?.attributes ?? {})).toBe(false);
    expect(requests.every((r) => (r.content ?? []).filter((b) => b.type === "image").length <= 1)).toBe(true);
  });

  it("settles an item whose provider cannot take images as that item's error", async () => {
    const { provider } = capturingProvider([{ name: "Ada" }], {});
    const results = await coerceMany<{ name: string }>(["Ada", photo], { provider, schema: nameSchema, primeCache: false });
    expect(results[0].ok).toBe(true);
    expect(results[1].ok).toBe(false);
    expect(results[1].ok === false && results[1].error).toBeInstanceOf(RangeError);
  });
});
