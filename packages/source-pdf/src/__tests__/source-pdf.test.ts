import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { budgetSources } from "@sembl/core";
import {
  PdfError,
  extractPdfMetadata,
  formatPdfMetadata,
  pdfInfo,
  pdfPages,
  pdfSource,
  pdfSources,
  pdfToText,
  readPdfFile,
  runsToText,
  itemsToText,
  selectPages,
} from "../index.js";
import { makePdf, textPage } from "./fixtures/pdf-writer.js";

/** A three-page brochure: prose, a table, and a scanned page with no text. */
const brochure = makePdf({
  info: {
    Title: "Sea Cabin brochure",
    Author: "Coastal Stays",
    Subject: "A cabin by the sea",
    Keywords: "cabin, sauna",
    CreationDate: "D:20240102030405Z",
    ModDate: "D:20240506070809+02'00'",
  },
  pages: [
    textPage(["Sea Cabin", "Sleeps 6 in two bedrooms.", "Pets welcome.", "", "Rate: $250 / night"]),
    {
      text: [
        { x: 72, y: 700, text: "Room" },
        { x: 250, y: 700, text: "Beds" },
        { x: 400, y: 700, text: "View" },
        { x: 72, y: 684, text: "Master" },
        { x: 250, y: 684, text: "1 king" },
        { x: 400, y: 684, text: "Sea" },
        { x: 72, y: 668, text: "Loft" },
        { x: 250, y: 668, text: "2 singles" },
        { x: 400, y: 668, text: "Forest" },
      ],
    },
    { image: true },
  ],
});

const scan = makePdf({ pages: [{ image: true }, { image: true }] });
const locked = makePdf({ pages: [textPage(["Secret text"])], info: { Title: "Locked" }, userPassword: "letmein" });

describe("runsToText (layout pass)", () => {
  const run = (str: string, x: number, y: number, size = 12) => ({ str, x, y, width: str.length * size * 0.5, fontSize: size });

  it("orders lines top to bottom and runs left to right whatever the content order", () => {
    const text = runsToText([run("world", 120, 700), run("Second", 72, 684), run("Hello", 72, 700)]);
    expect(text).toBe("Hello world\nSecond");
  });

  it("keeps a table row on one line with its cells apart", () => {
    const text = runsToText([run("Room", 72, 700), run("Beds", 250, 700), run("Master", 72, 684), run("1 king", 250, 684)]);
    expect(text).toBe("Room  Beds\nMaster  1 king");
  });

  it("joins runs that touch without a space and breaks paragraphs on a tall gap", () => {
    const text = runsToText([run("Hel", 72, 700), run("lo", 90, 700), run("Next para", 72, 660)]);
    expect(text).toBe("Hello\n\nNext para");
  });

  it("tolerates baselines that wobble within half a font size", () => {
    const text = runsToText([run("a", 72, 700), run("b", 90, 703), run("c", 108, 697)]);
    expect(text).toBe("a b c");
  });

  it("ignores marked-content markers and pdf.js's synthetic spaces", () => {
    const items = [
      { type: "beginMarkedContent" },
      { str: "A", transform: [12, 0, 0, 12, 72, 700], width: 8, height: 12 },
      { str: " ", transform: [12, 0, 0, 12, 80, 700], width: 100, height: 0 },
      { str: "B", transform: [12, 0, 0, 12, 200, 700], width: 8, height: 12 },
      { type: "endMarkedContent" },
    ];
    expect(itemsToText(items)).toBe("A  B");
  });
});

describe("selectPages", () => {
  it("expands ranges, lists and caps, ignoring numbers outside the document", () => {
    expect(selectPages(5)).toEqual([1, 2, 3, 4, 5]);
    expect(selectPages(5, { pages: { from: 2, to: 3 } })).toEqual([2, 3]);
    expect(selectPages(5, { pages: { from: 4 } })).toEqual([4, 5]);
    expect(selectPages(5, { pages: { to: 2 } })).toEqual([1, 2]);
    expect(selectPages(5, { pages: [3, 1, 3, 9, 0] })).toEqual([1, 3]);
    expect(selectPages(5, { maxPages: 2 })).toEqual([1, 2]);
    expect(selectPages(5, { pages: { from: 2 }, maxPages: 1 })).toEqual([2]);
    expect(selectPages(5, { pages: { from: 9 } })).toEqual([]);
  });
});

describe("pdfToText", () => {
  it("reconstructs lines and paragraphs and marks page breaks", async () => {
    const text = await pdfToText(brochure);
    expect(text).toContain("--- Page 1 ---\nSea Cabin\nSleeps 6 in two bedrooms.\nPets welcome.\n\nRate: $250 / night");
    expect(text).toContain("--- Page 2 ---\nRoom  Beds  View\nMaster  1 king  Sea\nLoft  2 singles  Forest");
    expect(text).not.toContain("--- Page 3 ---");
  });

  it("selects pages by range, list and cap", async () => {
    expect(await pdfToText(brochure, { pages: { from: 2 } })).toMatch(/^--- Page 2 ---\nRoom/);
    expect(await pdfToText(brochure, { pages: [2] })).not.toContain("Sea Cabin");
    expect(await pdfToText(brochure, { maxPages: 1 })).not.toContain("--- Page 2 ---");
    expect(await pdfToText(brochure, { pages: [3] })).toBe("");
  });

  it("returns an empty string for a scanned document", async () => {
    expect(await pdfToText(scan)).toBe("");
  });

  it("accepts an ArrayBuffer and leaves the caller's bytes intact", async () => {
    const copy = new Uint8Array(brochure);
    const text = await pdfToText(copy.buffer);
    expect(text).toContain("Sea Cabin");
    expect(copy.byteLength).toBe(brochure.byteLength);
    expect(await pdfToText(copy)).toContain("Sea Cabin");
  });
});

describe("pdfPages", () => {
  it("returns every selected page, empty ones included", async () => {
    const pages = await pdfPages(brochure);
    expect(pages.map((p) => p.number)).toEqual([1, 2, 3]);
    expect(pages[2].text).toBe("");
  });
});

describe("extractPdfMetadata", () => {
  it("reads the info dictionary and parses dates", async () => {
    const meta = await extractPdfMetadata(brochure);
    expect(meta).toEqual({
      title: "Sea Cabin brochure",
      author: "Coastal Stays",
      subject: "A cabin by the sea",
      keywords: "cabin, sauna",
      created: new Date("2024-01-02T03:04:05Z"),
      modified: new Date("2024-05-06T05:08:09Z"),
      pageCount: 3,
    });
  });

  it("leaves out what the document does not have", async () => {
    expect(await extractPdfMetadata(scan)).toEqual({ pageCount: 2 });
    expect(formatPdfMetadata({ pageCount: 2 })).toBe("pages: 2");
  });
});

describe("pdfInfo", () => {
  it("reports whether a document has a text layer", async () => {
    const info = await pdfInfo(brochure);
    expect(info).toMatchObject({ pageCount: 3, hasText: true, pagesWithText: 2, encrypted: false });
    expect(info.metadata.title).toBe("Sea Cabin brochure");
    expect(await pdfInfo(scan)).toMatchObject({ pageCount: 2, hasText: false, pagesWithText: 0 });
  });

  it("notes encryption once the password opened the document", async () => {
    expect(await pdfInfo(locked, { password: "letmein" })).toMatchObject({ hasText: true, encrypted: true });
  });
});

describe("pdfSource", () => {
  it("puts the metadata ahead of the text", async () => {
    const source = await pdfSource(brochure, "Brochure");
    expect(source.label).toBe("Brochure");
    expect(source.text.startsWith("Document metadata:\ntitle: Sea Cabin brochure\nauthor: Coastal Stays\n")).toBe(true);
    expect(source.text).toContain("pages: 3\n\nDocument text:\n--- Page 1 ---\nSea Cabin");
    expect((await pdfSource(brochure)).label).toBeUndefined();
  });

  it("can drop the metadata and passes page options through", async () => {
    const source = await pdfSource(brochure, "B", { meta: false, pages: [2] });
    expect(source.text.startsWith("Document text:\n--- Page 2 ---")).toBe(true);
  });

  it("keeps the metadata through SEMBL's head-keeping truncation", async () => {
    const long = makePdf({ info: { Title: "Long" }, pages: Array.from({ length: 12 }, (_, i) => textPage(Array(40).fill(`Page ${i + 1} filler text line`))) });
    const [cut] = budgetSources([await pdfSource(long, "Long")], 600).sources;
    expect(cut.text).toContain("title: Long");
    expect(cut.text).toContain("characters omitted");
  });
});

describe("pdfSources", () => {
  it("returns the metadata and one source per page with text", async () => {
    const sources = await pdfSources(brochure, "Brochure");
    expect(sources.map((s) => s.label)).toEqual(["Brochure (metadata)", "Brochure (page 1)", "Brochure (page 2)"]);
    expect(sources[1].text).toBe("Sea Cabin\nSleeps 6 in two bedrooms.\nPets welcome.\n\nRate: $250 / night");
    expect(sources[2].text).toContain("Room  Beds  View");
    expect((await pdfSources(brochure, undefined, { meta: false }))[0].label).toBe("Document (page 1)");
  });

  it("lets the budget trim a long page without touching the short ones", async () => {
    const long = makePdf({
      pages: [textPage(["Short page"]), textPage(Array(60).fill("A long page of filler text that goes on")), textPage(["Another short page"])],
    });
    const { sources } = budgetSources(await pdfSources(long, "Doc"), 700);
    expect(sources[1].text).toBe("Short page");
    expect(sources[2].text).toContain("characters omitted");
    expect(sources[3].text).toBe("Another short page");
  });

  it("returns nothing but the metadata for a scan", async () => {
    expect((await pdfSources(scan, "Scan")).map((s) => s.label)).toEqual(["Scan (metadata)"]);
  });
});

describe("errors", () => {
  it("names encryption clearly and opens with the password", async () => {
    await expect(pdfToText(locked)).rejects.toMatchObject({ name: "PdfError", code: "password-required" });
    await expect(pdfToText(locked, { password: "nope" })).rejects.toMatchObject({ code: "wrong-password" });
    expect(await pdfToText(locked, { password: "letmein" })).toBe("--- Page 1 ---\nSecret text");
    expect((await extractPdfMetadata(locked, { password: "letmein" })).title).toBe("Locked");
  });

  it("rejects bytes that are not a PDF, truncated PDFs and empty input", async () => {
    await expect(pdfToText(new TextEncoder().encode("hello"))).rejects.toBeInstanceOf(PdfError);
    await expect(pdfToText(new TextEncoder().encode("hello"))).rejects.toMatchObject({ code: "invalid" });
    await expect(pdfToText(brochure.subarray(0, 200))).rejects.toMatchObject({ code: "invalid" });
    await expect(pdfToText(new Uint8Array(0))).rejects.toMatchObject({ code: "invalid" });
    await expect(pdfToText("nope" as unknown as Uint8Array)).rejects.toMatchObject({ code: "invalid" });
  });

  it("gives up after the timeout", async () => {
    await expect(pdfToText(brochure, { timeoutMs: 0 })).rejects.toMatchObject({ code: "timeout" });
  });
});

describe("readPdfFile", () => {
  it("reads a file from disk into bytes any reader accepts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sembl-pdf-"));
    const path = join(dir, "brochure.pdf");
    await writeFile(path, brochure);
    const bytes = await readPdfFile(path);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(await pdfToText(bytes)).toContain("Sea Cabin");
  });
});
