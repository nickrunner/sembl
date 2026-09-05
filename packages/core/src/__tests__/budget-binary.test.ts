import { describe, it, expect } from "vitest";
import { budgetSources, capBinarySources } from "../coerce/budget.js";
import type { DocumentSource, ImageSource, Source } from "../coerce/sources.js";

const text = (n: number, ch = "a") => ch.repeat(n);
const image = (label: string): ImageSource => ({ label, image: { data: new Uint8Array([1, 2, 3]), mediaType: "image/png" } });
const pdf = (label: string): DocumentSource => ({ label, document: { url: `https://example.test/${label}.pdf` } });

describe("budgetSources with binary sources", () => {
  it("passes binary sources through in place and budgets only the text", () => {
    const sources: Source[] = [image("p1"), { label: "page", text: text(900) }, pdf("d1"), { label: "email", text: text(100) }];
    const result = budgetSources(sources, 500);
    expect(result.sources[0]).toBe(sources[0]);
    expect(result.sources[2]).toBe(sources[2]);
    expect(result.sources).toHaveLength(4);
    const page = result.sources[1] as { text: string };
    const email = result.sources[3] as { text: string };
    expect(email.text.length).toBe(100);
    expect(page.text.length).toBeLessThanOrEqual(400);
    expect(result.truncated.map((t) => t.label)).toEqual(["page"]);
  });

  it("counts binary sources as zero characters against the budget", () => {
    const sources: Source[] = [image("p1"), image("p2"), { text: text(100) }];
    const result = budgetSources(sources, 100);
    expect(result.truncated).toEqual([]);
    expect(result.sources).toEqual(sources);
  });

  it("leaves an all-binary input alone under any budget", () => {
    const sources: Source[] = [image("p1"), pdf("d1")];
    expect(budgetSources(sources, 1)).toEqual({ sources, truncated: [] });
  });
});

describe("capBinarySources", () => {
  const sources: Source[] = [{ text: "t1" }, image("p1"), pdf("d1"), image("p2"), { text: "t2" }, image("p3"), pdf("d2")];

  it("does nothing without a limit", () => {
    expect(capBinarySources(sources, {})).toEqual({ sources, dropped: [] });
  });

  it("drops extra images from the end and reports them with their input index", () => {
    const result = capBinarySources(sources, { maxImages: 1 });
    expect(result.sources.map((s) => s.label ?? "text")).toEqual(["text", "p1", "d1", "text", "d2"]);
    expect(result.dropped).toEqual([
      { label: "p2", kind: "image", index: 3 },
      { label: "p3", kind: "image", index: 5 },
    ]);
  });

  it("caps images and documents independently and never touches text", () => {
    const result = capBinarySources(sources, { maxImages: 0, maxDocuments: 1 });
    expect(result.sources.map((s) => s.label ?? "text")).toEqual(["text", "d1", "text"]);
    expect(result.dropped.map((d) => `${d.kind}:${d.label}`)).toEqual(["image:p1", "image:p2", "image:p3", "document:d2"]);
  });

  it("omits the label key for an unlabelled dropped source", () => {
    const result = capBinarySources([image("p1"), { image: { url: "https://example.test/x" } }], { maxImages: 1 });
    expect(result.dropped).toEqual([{ kind: "image", index: 1 }]);
  });
});
