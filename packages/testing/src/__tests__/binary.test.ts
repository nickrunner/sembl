import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { coerce } from "@sembl/core";
import type { ContentBlock, ImageSource, Provider, ProviderRequest, RuntimeSchema } from "@sembl/core";
import { RecordingProvider, ReplayProvider, describeBlock, recordingKey } from "../replay.js";
import type { Recording } from "../replay.js";
import { loadFixtures, runEval } from "../eval.js";

const schema: RuntimeSchema = {
  id: "Listing",
  description: "A listing.",
  fields: [{ name: "name", description: "Name", type: { kind: "string" }, required: true }],
};

const fixturesDir = resolve(import.meta.dirname, "fixtures", "binary");
const pngBytes = new Uint8Array(readFileSync(join(fixturesDir, "photo.png")));
const pngSha = createHash("sha256").update(pngBytes).digest("hex");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sembl-binary-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function imageProvider(answer: string): Provider {
  return {
    supportsImages: true,
    supportsDocuments: true,
    async complete() {
      return { data: { name: answer }, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    },
  };
}

describe("describeBlock", () => {
  it("keeps text, and reduces binary content to metadata and a hash", () => {
    expect(describeBlock({ type: "text", text: "t" })).toEqual({ type: "text", text: "t" });
    expect(describeBlock({ type: "image", label: "P", source: { data: pngBytes, mediaType: "image/png" } })).toEqual({
      type: "image",
      label: "P",
      mediaType: "image/png",
      sha256: pngSha,
      bytes: pngBytes.byteLength,
    });
    expect(describeBlock({ type: "document", source: { url: "https://example.test/a.pdf" } })).toEqual({
      type: "document",
      url: "https://example.test/a.pdf",
    });
  });

  it("hashes base64 and bytes of the same content identically", () => {
    const asBytes = describeBlock({ type: "image", source: { data: pngBytes, mediaType: "image/png" } });
    const asBase64 = describeBlock({
      type: "image",
      source: { data: Buffer.from(pngBytes).toString("base64"), mediaType: "image/png" },
    });
    expect(asBase64).toEqual(asBytes);
  });
});

describe("recordingKey with content", () => {
  const base: ProviderRequest = { systemPrompt: "sys", userInput: '<source type="image/png" />', jsonSchema: {}, schema };
  const withImage = (data: Uint8Array | string): ProviderRequest => ({
    ...base,
    content: [
      { type: "text", text: '<source type="image/png">\n' },
      { type: "image", source: { data, mediaType: "image/png" } },
      { type: "text", text: "\n</source>" },
    ],
  });

  it("distinguishes two images with the same placeholder rendering", () => {
    expect(recordingKey(withImage(pngBytes))).not.toBe(recordingKey(withImage(new Uint8Array([1, 2, 3]))));
    expect(recordingKey(withImage(pngBytes))).not.toBe(recordingKey(base));
  });

  it("is stable across bytes and base64 forms of the same image", () => {
    expect(recordingKey(withImage(pngBytes))).toBe(recordingKey(withImage(Buffer.from(pngBytes).toString("base64"))));
  });

  it("keys a URL source on its URL", () => {
    const url = (u: string): ProviderRequest => ({
      ...base,
      content: [{ type: "image", source: { url: u } }],
    });
    expect(recordingKey(url("https://example.test/a"))).not.toBe(recordingKey(url("https://example.test/b")));
    expect(recordingKey(url("https://example.test/a"))).toBe(recordingKey(url("https://example.test/a")));
  });
});

describe("recording and replaying an image request", () => {
  const photo: ImageSource = { label: "Photo", image: { data: pngBytes, mediaType: "image/png" } };

  it("stores block metadata without the bytes, and replays the same image", async () => {
    const recorder = new RecordingProvider(imageProvider("Sea Cabin"), dir);
    expect(recorder.supportsImages).toBe(true);
    expect(recorder.supportsDocuments).toBe(true);
    await coerce(photo, { provider: recorder, schema });

    const [file] = readdirSync(dir);
    const recording = JSON.parse(readFileSync(join(dir, file), "utf8")) as Recording;
    expect(recording.request.content).toEqual([
      { type: "text", text: '<source label="Photo" type="image/png">\n' },
      { type: "image", label: "Photo", mediaType: "image/png", sha256: pngSha, bytes: pngBytes.byteLength },
      { type: "text", text: "\n</source>" },
    ]);
    expect(readFileSync(join(dir, file), "utf8")).not.toContain(Buffer.from(pngBytes).toString("base64"));

    const replay = new ReplayProvider(dir);
    expect(replay.supportsImages).toBe(true);
    expect(await coerce(photo, { provider: replay, schema })).toEqual({ name: "Sea Cabin" });

    const other: ImageSource = { label: "Photo", image: { data: new Uint8Array([9, 9, 9]), mediaType: "image/png" } };
    await expect(coerce(other, { provider: replay, schema })).rejects.toThrow(/No recording/);
  });

  it("follows the fallback's capabilities", () => {
    const textOnly: Provider = { async complete() { return { data: {} }; } };
    expect(new ReplayProvider(dir, { fallback: textOnly }).supportsImages).toBe(false);
    expect(new ReplayProvider(dir, { fallback: imageProvider("x") }).supportsDocuments).toBe(true);
    expect(new RecordingProvider(textOnly, dir).supportsImages).toBe(false);
  });
});

describe("eval fixtures with binary inputs", () => {
  it("loads image and document inputs beside the fixture with their media types", () => {
    const fixtures = loadFixtures(fixturesDir);
    const photo = fixtures.find((f) => f.name === "photo");
    expect(photo).toBeDefined();
    const input = photo!.input as ImageSource;
    expect(input.label).toBe("Listing photo");
    expect(input.image).toMatchObject({ mediaType: "image/png" });
    expect((input.image as { data: Uint8Array }).data).toEqual(pngBytes);

    const scan = fixtures.find((f) => f.name === "scan");
    const list = scan!.input as [ImageSource, { document: { data: Uint8Array; mediaType: string } }];
    expect(list[0].image).toEqual({ url: "https://example.test/photo.jpg" });
    expect(list[1].document.mediaType).toBe("application/pdf");
    expect(Buffer.from(list[1].document.data).toString("utf8").startsWith("%PDF-1.4")).toBe(true);
  });

  it("rejects an unknown extension", () => {
    const bad = mkdtempSync(join(tmpdir(), "sembl-fixture-"));
    try {
      writeFileSync(join(bad, "x.json"), JSON.stringify({ input: { image: "photo.tiff" }, expected: {} }));
      expect(() => loadFixtures(bad)).toThrow(/Unknown image type/);
    } finally {
      rmSync(bad, { recursive: true, force: true });
    }
  });

  it("runs an image fixture through a provider that takes images", async () => {
    const fixtures = loadFixtures(fixturesDir).filter((f) => f.name === "photo");
    const seen: ContentBlock[][] = [];
    const provider: Provider = {
      supportsImages: true,
      async complete(request) {
        seen.push(request.content ?? []);
        return { data: { name: "Sea Cabin" } };
      },
    };
    const report = await runEval({ provider, schema, fixtures });
    expect(report.totals.exact).toBe(1);
    expect(seen[0].some((b) => b.type === "image")).toBe(true);
  });
});
