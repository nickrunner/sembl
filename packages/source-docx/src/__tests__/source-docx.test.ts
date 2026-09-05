import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll } from "vitest";
import { budgetSources } from "@sembl/core";
import { DocxError, docxSource, docxSources, docxToText, extractDocxMetadata, readDocxFile } from "../index.js";
import { docxPackage, handoverDocx, odtPackage, p, plainDocx, zip } from "./fixtures.js";

let handover: Uint8Array;
let plain: Uint8Array;

beforeAll(async () => {
  handover = await handoverDocx();
  plain = await plainDocx();
});

describe("docxToText", () => {
  it("renders headings as # lines with the title first", async () => {
    const text = await docxToText(handover);
    expect(text).toContain("# Heron Point Cabin\n\nHandover notes for the incoming host.\n\n# Access\n");
    expect(text).toContain("\n\n## Utilities\n\n");
    expect(text.indexOf("# Access")).toBeLessThan(text.indexOf("# Amenities"));
    expect(text.indexOf("# Amenities")).toBeLessThan(text.indexOf("# Contacts"));
  });

  it("renders numbered and bulleted lists, nested by level", async () => {
    const text = await docxToText(handover);
    expect(text).toContain("1. Unlock the gate\n2. Key box is behind the boot rack");
    expect(text).toContain("- Sauna\n- Hot tub\n  - Cover must stay on");
  });

  it("renders tables as pipe rows with a header separator, escaping pipes", async () => {
    const text = await docxToText(handover);
    expect(text).toContain(
      "| System | Location | Notes |\n| --- | --- | --- |\n| Water | Under the stairs | Shut off \\| drain in winter |\n| Power | Porch |  |",
    );
  });

  it("can render tables one cell per line", async () => {
    const text = await docxToText(handover, { tables: "lines" });
    expect(text).toContain("System\nLocation\nNotes\n\nWater\nUnder the stairs\nShut off | drain in winter\n\nPower\nPorch\n");
    expect(text).not.toContain("| --- |");
  });

  it("drops bold and italic but keeps their text", async () => {
    const text = await docxToText(handover);
    expect(text).toContain("The gate code is 4471.");
    expect(text).not.toMatch(/\*\*|<b>|<em>/);
  });

  it("marks footnotes inline and appends them", async () => {
    const text = await docxToText(handover);
    expect(text).toContain("The gate code is 4471.[^1]");
    expect(text).toMatch(/\n\nFootnotes:\n\[\^1\]: The gate code changes every season\.(\n|$)/);
  });

  it("leaves footnotes out when asked", async () => {
    const text = await docxToText(handover, { footnotes: false });
    expect(text).toContain("The gate code is 4471.\n");
    expect(text).not.toContain("[^1]");
    expect(text).not.toContain("Footnotes:");
  });

  it("accepts tracked changes: insertions kept, deletions gone", async () => {
    const text = await docxToText(handover);
    expect(text).toContain("Call Jonas for repairs.");
    expect(text).not.toContain("Erik");
  });

  it("lists embedded images by their description", async () => {
    expect(await docxToText(handover)).toContain("[image: Fuse box in the utility room]");
  });

  it("omits headers and footers unless asked", async () => {
    const without = await docxToText(handover);
    expect(without).not.toContain("Confidential");
    expect(without).not.toContain("Footer:");
    const withThem = await docxToText(handover, { headersFooters: true });
    expect(withThem).toContain("Document text:\nHeader:\nConfidential — for the incoming host\n\n# Heron Point Cabin");
    expect(withThem).toMatch(/\n\nFooter:\nHeron Point Cabin handover$/);
  });

  it("puts the metadata ahead of the text, like source-html", async () => {
    const text = await docxToText(handover);
    expect(text.startsWith("Document metadata:\ntitle: Heron Point Cabin — Handover Notes\nauthor: Marta Lindqvist\ncreated: 20")).toBe(true);
    expect(text).toContain("\n\nDocument text:\n# Heron Point Cabin");
    expect((await docxToText(handover, { metadata: false })).startsWith("Document text:\n")).toBe(true);
  });

  it("renders a document without headings as plain paragraphs", async () => {
    expect(await docxToText(plain, { metadata: false })).toBe("Document text:\nFirst paragraph.\nSecond paragraph.");
  });
});

describe("extractDocxMetadata", () => {
  it("reads the core properties", async () => {
    const meta = await extractDocxMetadata(handover);
    expect(meta.title).toBe("Heron Point Cabin — Handover Notes");
    expect(meta.author).toBe("Marta Lindqvist");
    expect(meta.created).toBeInstanceOf(Date);
    expect(meta.modified).toBeInstanceOf(Date);
    expect(meta.wordCount).toBeUndefined();
  });

  it("reads the word count from the app properties and skips unparseable dates", async () => {
    const data = docxPackage({
      body: p("Hello"),
      core: "<dc:title>T</dc:title><dcterms:created>not a date</dcterms:created>",
      app: "<Words>1234</Words>",
    });
    expect(await extractDocxMetadata(data)).toEqual({ title: "T", wordCount: 1234 });
    expect(await docxToText(data)).toBe("Document metadata:\ntitle: T\nwords: 1234\n\nDocument text:\nHello");
  });

  it("returns nothing for a document without properties", async () => {
    expect(await extractDocxMetadata(docxPackage({ body: p("Hello") }))).toEqual({});
  });
});

describe("docxSource and docxSources", () => {
  it("builds a labelled source", async () => {
    const source = await docxSource(plain, "Notes", { metadata: false });
    expect(source).toEqual({ label: "Notes", text: "Document text:\nFirst paragraph.\nSecond paragraph." });
    expect(await docxSource(plain, undefined, { metadata: false })).toEqual({ text: "Document text:\nFirst paragraph.\nSecond paragraph." });
  });

  it("splits on the top-level headings, one source per section", async () => {
    const sources = await docxSources(handover, "Notes");
    expect(sources.map((s) => s.label)).toEqual(["Notes", "Notes — Access", "Notes — Amenities", "Notes — Contacts"]);
    expect(sources[0].text).toContain("Document metadata:\ntitle: Heron Point Cabin");
    expect(sources[0].text).toContain("Document text:\n# Heron Point Cabin\n\nHandover notes for the incoming host.");
    expect(sources[1].text).toBe(
      "# Access\n\nThe gate code is 4471.[^1]\n1. Unlock the gate\n2. Key box is behind the boot rack\n\nFootnotes:\n[^1]: The gate code changes every season.",
    );
    expect(sources[2].text).toContain("## Utilities\n\n| System |");
    expect(sources[2].text).not.toContain("Footnotes:");
    expect(sources[3].text).toBe("# Contacts\n\nCall Jonas for repairs.\n[image: Fuse box in the utility room]");
  });

  it("puts headers on the first source and footers on the last", async () => {
    const sources = await docxSources(handover, "Notes", { headersFooters: true });
    expect(sources[0].text).toContain("Document text:\nHeader:\nConfidential");
    expect(sources[3].text).toMatch(/\n\nFooter:\nHeron Point Cabin handover$/);
    expect(sources[1].text).not.toContain("Footer:");
  });

  it("returns one source for a document with no headings", async () => {
    expect(await docxSources(plain, "Notes", { metadata: false })).toEqual([
      { label: "Notes", text: "Document text:\nFirst paragraph.\nSecond paragraph." },
    ]);
  });

  it("lets the budget trim a long section while short ones stay whole", async () => {
    const filler = Array.from({ length: 300 }, (_, i) => p(`Rule ${i}: keep the deck clear of leaves and pine needles.`)).join("");
    const data = docxPackage({
      body: [
        p("Access", '<w:outlineLvl w:val="0"/>'),
        p("Gate code 4471."),
        p("House rules", '<w:outlineLvl w:val="0"/>'),
        filler,
      ].join(""),
    });
    const sources = await docxSources(data, "Notes");
    expect(sources.map((s) => s.label)).toEqual(["Notes — Access", "Notes — House rules"]);
    const [access, rules] = budgetSources(sources, 2000).sources;
    expect(access.text).toBe("# Access\n\nGate code 4471.");
    expect(rules.text).toContain("characters omitted");
    expect(rules.text.startsWith("# House rules\n\nRule 0:")).toBe(true);
  });

  it("disambiguates repeated headings and shortens long ones", async () => {
    const data = docxPackage({
      body: [
        p("Notes", '<w:outlineLvl w:val="0"/>'),
        p("a"),
        p("Notes", '<w:outlineLvl w:val="0"/>'),
        p("b"),
        p("A".repeat(80), '<w:outlineLvl w:val="0"/>'),
        p("c"),
      ].join(""),
    });
    const labels = (await docxSources(data, "Doc")).map((s) => s.label);
    expect(labels).toEqual(["Doc — Notes", "Doc — Notes (2)", `Doc — ${"A".repeat(59)}…`]);
  });
});

describe("hand-built OOXML corners", () => {
  it("finds headings by outline level, style name and style inheritance", async () => {
    const data = docxPackage({
      styles: [
        '<w:style w:type="paragraph" w:styleId="Rubrik2"><w:name w:val="heading 2"/></w:style>',
        '<w:style w:type="paragraph" w:styleId="MyHeading"><w:name w:val="My Heading"/><w:basedOn w:val="Rubrik2"/></w:style>',
        '<w:style w:type="paragraph" w:styleId="Deep"><w:name w:val="Deep"/><w:pPr><w:outlineLvl w:val="2"/></w:pPr></w:style>',
        '<w:style w:type="paragraph" w:styleId="Body"><w:name w:val="Body"/><w:pPr><w:outlineLvl w:val="9"/></w:pPr></w:style>',
      ].join(""),
      body: [
        p("Localised", '<w:pStyle w:val="Rubrik2"/>'),
        p("Inherited", '<w:pStyle w:val="MyHeading"/>'),
        p("By outline", '<w:pStyle w:val="Deep"/>'),
        p("Explicit wins", '<w:pStyle w:val="Deep"/><w:outlineLvl w:val="0"/>'),
        p("Body text", '<w:pStyle w:val="Body"/>'),
      ].join(""),
    });
    expect(await docxToText(data)).toBe(
      "Document text:\n## Localised\n\n## Inherited\n\n### By outline\n\n# Explicit wins\n\nBody text",
    );
  });

  it("reads list membership and number format from numbering and styles", async () => {
    const data = docxPackage({
      numbering: [
        '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>',
        '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>',
        '<w:num w:numId="2"><w:abstractNumId w:val="0"/><w:lvlOverride w:ilvl="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:lvlOverride></w:num>',
      ].join(""),
      styles: '<w:style w:type="paragraph" w:styleId="ListPara"><w:name w:val="List Paragraph"/><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr></w:style>',
      body: [
        p("one", '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'),
        p("two", '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'),
        p("nested", '<w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr>'),
        p("three", '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'),
        p("styled", '<w:pStyle w:val="ListPara"/>'),
        p("not a list", '<w:pStyle w:val="ListPara"/><w:numPr><w:numId w:val="0"/></w:numPr>'),
        p("overridden", '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr>'),
      ].join(""),
    });
    expect(await docxToText(data)).toBe(
      "Document text:\n1. one\n2. two\n  - nested\n3. three\n4. styled\nnot a list\n- overridden",
    );
  });

  it("handles merged cells, header rows, nested content and cells in content controls", async () => {
    const cell = (text: string, props = "") => `<w:tc>${props ? `<w:tcPr>${props}</w:tcPr>` : ""}${p(text)}</w:tc>`;
    const data = docxPackage({
      body: `<w:tbl>
        <w:tr><w:trPr><w:tblHeader/></w:trPr>${cell("Room")}${cell("Beds")}${cell("Notes")}</w:tr>
        <w:tr>${cell("Loft", '<w:vMerge w:val="restart"/>')}${cell("Two singles")}${cell("Ladder access")}</w:tr>
        <w:tr>${cell("", "<w:vMerge/>")}${cell("Spans both", '<w:gridSpan w:val="2"/>')}</w:tr>
        <w:sdt><w:sdtContent><w:tr>${cell("Snug")}<w:tc>${p("Sofa bed")}${p("Fold flat")}</w:tc>${cell("")}</w:tr></w:sdtContent></w:sdt>
      </w:tbl>`,
    });
    expect(await docxToText(data)).toBe(
      [
        "Document text:",
        "| Room | Beds | Notes |",
        "| --- | --- | --- |",
        "| Loft | Two singles | Ladder access |",
        "|  | Spans both |  |",
        "| Snug | Sofa bed / Fold flat |  |",
      ].join("\n"),
    );
  });

  it("keeps hyperlink and field result text, tabs, line breaks and content controls; skips the TOC", async () => {
    const data = docxPackage({
      body: [
        '<w:sdt><w:sdtPr><w:docPartObj><w:docPartGallery w:val="Table of Contents"/></w:docPartObj></w:sdtPr><w:sdtContent>',
        p("Access 1"),
        "</w:sdtContent></w:sdt>",
        '<w:p><w:r><w:t xml:space="preserve">See </w:t></w:r><w:hyperlink r:id="rId9"><w:r><w:t>the map</w:t></w:r></w:hyperlink>',
        '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>PAGE</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>',
        '<w:r><w:t xml:space="preserve"> on page 3</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>',
        '<w:r><w:tab/><w:t>tabbed</w:t><w:br/><w:t>next line</w:t><w:br w:type="page"/><w:t xml:space="preserve"> same</w:t></w:r></w:p>',
        "<w:sdt><w:sdtContent>",
        p("Inside a control"),
        "</w:sdtContent></w:sdt>",
        "<w:p><w:r><w:t>Symbols: &amp; &lt; &#x2014; &#8364;</w:t></w:r></w:p>",
      ].join(""),
    });
    expect(await docxToText(data)).toBe(
      "Document text:\nSee the map on page 3 tabbed\nnext line same\nInside a control\nSymbols: & < — €",
    );
  });

  it("drops deleted and moved-away text and takes the mc:Choice branch only once", async () => {
    const data = docxPackage({
      body: [
        '<w:p><w:r><w:t xml:space="preserve">Keep </w:t></w:r><w:del w:id="1" w:author="a" w:date="2026-01-01T00:00:00Z"><w:r><w:delText>gone </w:delText></w:r></w:del>',
        '<w:ins w:id="2" w:author="a" w:date="2026-01-01T00:00:00Z"><w:r><w:t xml:space="preserve">added </w:t></w:r></w:ins>',
        '<w:moveFrom w:id="3" w:author="a" w:date="2026-01-01T00:00:00Z"><w:r><w:t>moved-from </w:t></w:r></w:moveFrom>',
        '<w:moveTo w:id="4" w:author="a" w:date="2026-01-01T00:00:00Z"><w:r><w:t>moved-to</w:t></w:r></w:moveTo></w:p>',
        "<w:p><w:r><mc:AlternateContent><mc:Choice Requires=\"wps\"><w:drawing><wp:inline><wp:docPr id=\"1\" name=\"Box\"/><a:graphic><a:graphicData><wps:wsp xmlns:wps=\"http://schemas.microsoft.com/office/word/2010/wordprocessingShape\"><wps:txbx><w:txbxContent>",
        p("Boxed text"),
        "</w:txbxContent></wps:txbx></wps:wsp></a:graphicData></a:graphic></wp:inline></w:drawing></mc:Choice><mc:Fallback><w:pict><v:shape xmlns:v=\"urn:schemas-microsoft-com:vml\"><v:textbox><w:txbxContent>",
        p("Boxed text"),
        "</w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>",
      ].join(""),
    });
    expect(await docxToText(data)).toBe("Document text:\nKeep added moved-to\nBoxed text");
  });

  it("names images from the media file when there is no description", async () => {
    const data = docxPackage({
      rels: '<Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>',
      body: `<w:p><w:r><w:drawing><wp:inline><wp:docPr id="1" name="Picture 1"/><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rId7"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r><w:r><w:t xml:space="preserve"> Fuse box</w:t></w:r></w:p>`,
    });
    expect(await docxToText(data)).toBe("Document text:\n[image: image1.png] Fuse box");
  });

  it("numbers footnotes and endnotes in order of first reference", async () => {
    const data = docxPackage({
      footnotes: [
        '<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>',
        '<w:footnote w:id="7"><w:p><w:r><w:footnoteRef/></w:r><w:r><w:t>Seven.</w:t></w:r></w:p><w:p><w:r><w:t>Second paragraph.</w:t></w:r></w:p></w:footnote>',
        '<w:footnote w:id="3"><w:p><w:r><w:t>Three.</w:t></w:r></w:p></w:footnote>',
      ].join(""),
      body: [
        '<w:p><w:r><w:t>A</w:t></w:r><w:r><w:footnoteReference w:id="7"/></w:r><w:r><w:t xml:space="preserve"> B</w:t></w:r><w:r><w:footnoteReference w:id="3"/></w:r><w:r><w:footnoteReference w:id="7"/></w:r><w:r><w:footnoteReference w:id="99"/></w:r></w:p>',
      ].join(""),
    });
    expect(await docxToText(data)).toBe(
      "Document text:\nA[^1] B[^2][^1]\n\nFootnotes:\n[^1]: Seven. Second paragraph.\n[^2]: Three.",
    );
  });
});

describe("OpenDocument text", () => {
  const odt = () =>
    odtPackage({
      automaticStyles: [
        '<style:style style:name="P1" style:family="paragraph" style:parent-style-name="Title"/>',
        '<text:list-style style:name="L1"><text:list-level-style-number text:level="1"/><text:list-level-style-bullet text:level="2"/></text:list-style>',
      ].join(""),
      styles: [
        '<office:styles><style:style style:name="Title" style:family="paragraph"/></office:styles>',
        '<office:master-styles><style:master-page style:name="Standard"><style:header><text:p>Confidential</text:p></style:header><style:footer><text:p>Page footer</text:p></style:footer></style:master-page></office:master-styles>',
      ].join(""),
      meta: '<dc:title>Cabin notes</dc:title><meta:initial-creator>Marta</meta:initial-creator><meta:creation-date>2026-08-14T09:12:00</meta:creation-date><dc:date>2026-08-15T10:00:00</dc:date><meta:document-statistic meta:word-count="42"/>',
      body: [
        '<text:p text:style-name="P1">Heron Point Cabin</text:p>',
        '<text:h text:outline-level="1">Access</text:h>',
        '<text:p>Gate<text:s text:c="2"/>code <text:span text:style-name="T1">4471</text:span><text:note text:note-class="footnote"><text:note-citation>1</text:note-citation><text:note-body><text:p>Changes each season.</text:p></text:note-body></text:note><text:line-break/>Key under the mat</text:p>',
        '<text:list text:style-name="L1"><text:list-item><text:p>Unlock</text:p><text:list><text:list-item><text:p>Push hard</text:p></text:list-item></text:list></text:list-item><text:list-item><text:p>Enter</text:p></text:list-item></text:list>',
        '<text:h text:outline-level="2">Utilities</text:h>',
        '<table:table><table:table-column/><table:table-header-rows><table:table-row><table:table-cell><text:p>System</text:p></table:table-cell><table:table-cell><text:p>Where</text:p></table:table-cell></table:table-row></table:table-header-rows>',
        '<table:table-row><table:table-cell table:number-columns-spanned="2"><text:p>Water: under the stairs</text:p></table:table-cell><table:covered-table-cell/></table:table-row></table:table>',
        '<text:h text:outline-level="1">Contacts</text:h>',
        '<text:p><draw:frame draw:name="Image1"><draw:image xlink:href="Pictures/fuse.png"/></draw:frame> Call Jonas.</text:p>',
        "<text:tracked-changes><text:changed-region><text:deletion><text:p>deleted text</text:p></text:deletion></text:changed-region></text:tracked-changes>",
      ].join(""),
    });

  it("renders headings, lists, tables, notes and images", async () => {
    expect(await docxToText(odt(), { metadata: false })).toBe(
      [
        "Document text:",
        "# Heron Point Cabin",
        "",
        "# Access",
        "",
        "Gate code 4471[^1]",
        "Key under the mat",
        "1. Unlock",
        "  - Push hard",
        "2. Enter",
        "",
        "## Utilities",
        "",
        "| System | Where |",
        "| --- | --- |",
        "| Water: under the stairs |  |",
        "",
        "# Contacts",
        "",
        "[image: fuse.png] Call Jonas.",
        "",
        "Footnotes:",
        "[^1]: Changes each season.",
      ].join("\n"),
    );
  });

  it("reads metadata, headers and footers", async () => {
    expect(await extractDocxMetadata(odt())).toEqual({
      title: "Cabin notes",
      author: "Marta",
      created: new Date("2026-08-14T09:12:00"),
      modified: new Date("2026-08-15T10:00:00"),
      wordCount: 42,
    });
    const text = await docxToText(odt(), { headersFooters: true });
    expect(text).toContain("Document text:\nHeader:\nConfidential\n\n# Heron Point Cabin");
    expect(text).toMatch(/\n\nFooter:\nPage footer$/);
  });

  it("splits into sections like a .docx", async () => {
    const labels = (await docxSources(odt(), "Cabin")).map((s) => s.label);
    expect(labels).toEqual(["Cabin", "Cabin — Access", "Cabin — Contacts"]);
  });
});

describe("errors", () => {
  const expectError = async (data: Uint8Array, code: DocxError["code"], message: RegExp) => {
    const error = await docxToText(data).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DocxError);
    expect((error as DocxError).code).toBe(code);
    expect((error as DocxError).message).toMatch(message);
  };

  it("rejects data that is not a zip", async () => {
    await expectError(new TextEncoder().encode("Just some text, not a document at all."), "not-a-document", /not a zip/);
    await expectError(new Uint8Array(0), "not-a-document", /not a zip/);
  });

  it("recognises OLE files as encrypted or legacy .doc", async () => {
    const ole = new Uint8Array(64);
    ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    await expectError(ole, "encrypted", /password-protected|legacy/);
  });

  it("rejects RTF and other Office formats clearly", async () => {
    await expectError(new TextEncoder().encode("{\\rtf1\\ansi Hello}"), "unsupported", /RTF/);
    await expectError(zip({ "xl/workbook.xml": "<workbook/>" }), "unsupported", /spreadsheet/);
    await expectError(odtPackage({ body: "", mimetype: "application/vnd.oasis.opendocument.spreadsheet" }), "unsupported", /spreadsheet/);
  });

  it("rejects a zip that is not a document", async () => {
    await expectError(zip({ "readme.txt": "hi" }), "not-a-document", /no word\/document.xml or content.xml/);
  });

  it("rejects encrypted packages", async () => {
    await expectError(zip({ "word/document.xml": "<w:document/>" }, { encrypted: true }), "encrypted", /encrypted/);
    await expectError(
      odtPackage({ body: "", manifest: '<manifest:encryption-data><manifest:algorithm/></manifest:encryption-data>' }),
      "encrypted",
      /password-protected/,
    );
  });

  it("reports malformed XML and truncated archives", async () => {
    await expectError(zip({ "word/document.xml": "<w:document><w:body><w:p>oops</w:body></w:document>" }), "malformed", /not well-formed/);
    await expectError(zip({ "word/document.xml": "<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"/>" }), "malformed", /no <w:body>/);
    const truncated = handover.slice(0, Math.floor(handover.length / 2));
    await expectError(truncated, "malformed", /central directory|corrupt|past the end/);
  });

  it("accepts an ArrayBuffer as well as a Uint8Array", async () => {
    const buffer = handover.buffer.slice(handover.byteOffset, handover.byteOffset + handover.byteLength) as ArrayBuffer;
    expect(await docxToText(buffer)).toContain("# Access");
  });
});

describe("readDocxFile", () => {
  it("reads bytes from disk for the other functions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sembl-docx-"));
    const path = join(dir, "notes.docx");
    await writeFile(path, handover);
    const data = await readDocxFile(path);
    expect(data).toBeInstanceOf(Uint8Array);
    expect((await docxSources(data, "Notes")).map((s) => s.label)).toContain("Notes — Access");
  });
});
