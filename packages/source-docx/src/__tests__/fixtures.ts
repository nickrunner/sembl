/**
 * Test documents, built rather than checked in. The realistic one comes
 * from the `docx` package, which writes what Word writes — deflated parts,
 * a styles part, numbering definitions. The hand-built ones exercise the
 * corners a generator never produces: outline levels without styles,
 * merged cells, content controls, tracked deletions of whole runs, and
 * broken packages.
 */
import {
  AlignmentType,
  DeletedTextRun,
  Document,
  Footer,
  FootnoteReferenceRun,
  Header,
  HeadingLevel,
  ImageRun,
  InsertedTextRun,
  LevelFormat,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
} from "docx";

/** A 1×1 transparent PNG. */
export const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

function cell(text: string): TableCell {
  return new TableCell({ children: [new Paragraph(text)] });
}

/** A short handover document with every structure the package handles. */
export async function handoverDocx(): Promise<Uint8Array> {
  const revision = { author: "Marta Lindqvist", date: "2026-08-14T09:12:00Z" };
  const doc = new Document({
    title: "Heron Point Cabin — Handover Notes",
    creator: "Marta Lindqvist",
    numbering: {
      config: [
        {
          reference: "steps",
          levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.START }],
        },
      ],
    },
    footnotes: {
      1: { children: [new Paragraph("The gate code changes every season.")] },
    },
    sections: [
      {
        headers: { default: new Header({ children: [new Paragraph("Confidential — for the incoming host")] }) },
        footers: { default: new Footer({ children: [new Paragraph("Heron Point Cabin handover")] }) },
        children: [
          new Paragraph({ text: "Heron Point Cabin", heading: HeadingLevel.TITLE }),
          new Paragraph("Handover notes for the incoming host."),
          new Paragraph({ text: "Access", heading: HeadingLevel.HEADING_1 }),
          new Paragraph({
            children: [
              new TextRun("The gate code is "),
              new TextRun({ text: "4471", bold: true }),
              new TextRun({ text: ".", italics: true }),
              new FootnoteReferenceRun(1),
            ],
          }),
          new Paragraph({ text: "Unlock the gate", numbering: { reference: "steps", level: 0 } }),
          new Paragraph({ text: "Key box is behind the boot rack", numbering: { reference: "steps", level: 0 } }),
          new Paragraph({ text: "Amenities", heading: HeadingLevel.HEADING_1 }),
          new Paragraph({ text: "Sauna", bullet: { level: 0 } }),
          new Paragraph({ text: "Hot tub", bullet: { level: 0 } }),
          new Paragraph({ text: "Cover must stay on", bullet: { level: 1 } }),
          new Paragraph({ text: "Utilities", heading: HeadingLevel.HEADING_2 }),
          new Table({
            rows: [
              new TableRow({ tableHeader: true, children: [cell("System"), cell("Location"), cell("Notes")] }),
              new TableRow({ children: [cell("Water"), cell("Under the stairs"), cell("Shut off | drain in winter")] }),
              new TableRow({ children: [cell("Power"), cell("Porch"), cell("")] }),
            ],
          }),
          new Paragraph({ text: "Contacts", heading: HeadingLevel.HEADING_1 }),
          new Paragraph({
            children: [
              new TextRun("Call "),
              new InsertedTextRun({ text: "Jonas", id: 1, ...revision }),
              new DeletedTextRun({ text: "Erik", id: 2, ...revision }),
              new TextRun(" for repairs."),
            ],
          }),
          new Paragraph({
            children: [
              new ImageRun({
                type: "png",
                data: PNG,
                transformation: { width: 20, height: 20 },
                altText: { name: "fuse-box", description: "Fuse box in the utility room", title: "Fuse box" },
              }),
            ],
          }),
        ],
      },
    ],
  });
  return new Uint8Array(await Packer.toBuffer(doc));
}

/** A document that is just paragraphs, with nothing to split on. */
export async function plainDocx(): Promise<Uint8Array> {
  const doc = new Document({
    sections: [{ children: [new Paragraph("First paragraph."), new Paragraph("Second paragraph.")] }],
  });
  return new Uint8Array(await Packer.toBuffer(doc));
}

// --- A stored-only zip writer, enough for hand-built packages. ---

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipOptions {
  /** Set the encryption flag on every entry, as a password-protected zip would. */
  encrypted?: boolean;
}

/** Write entries as an uncompressed zip. */
export function zip(entries: Record<string, string | Uint8Array>, options: ZipOptions = {}): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const flags = options.encrypted ? 1 : 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
    const nameBytes = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length / 2, 8);
  end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

export interface DocxParts {
  body: string;
  styles?: string;
  numbering?: string;
  footnotes?: string;
  /** Extra document relationships, as `<Relationship …/>` markup. */
  rels?: string;
  core?: string;
  app?: string;
}

/** A minimal package around a `<w:body>`. */
export function docxPackage(parts: DocxParts): Uint8Array {
  const entries: Record<string, string> = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`,
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${parts.body}</w:body></w:document>`,
    "word/_rels/document.xml.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdNum" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/><Relationship Id="rIdFn" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>${parts.rels ?? ""}</Relationships>`,
  };
  if (parts.styles) entries["word/styles.xml"] = `<?xml version="1.0" encoding="UTF-8"?><w:styles ${W}>${parts.styles}</w:styles>`;
  if (parts.numbering) entries["word/numbering.xml"] = `<?xml version="1.0" encoding="UTF-8"?><w:numbering ${W}>${parts.numbering}</w:numbering>`;
  if (parts.footnotes) entries["word/footnotes.xml"] = `<?xml version="1.0" encoding="UTF-8"?><w:footnotes ${W}>${parts.footnotes}</w:footnotes>`;
  if (parts.core) {
    entries["docProps/core.xml"] = `<?xml version="1.0" encoding="UTF-8"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">${parts.core}</cp:coreProperties>`;
  }
  if (parts.app) {
    entries["docProps/app.xml"] = `<?xml version="1.0" encoding="UTF-8"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">${parts.app}</Properties>`;
  }
  return zip(entries);
}

/** A paragraph of plain runs, optionally with paragraph properties. */
export function p(text: string, props = ""): string {
  return `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ""}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

export interface OdtParts {
  body: string;
  /** Automatic styles inside content.xml. */
  automaticStyles?: string;
  /** The whole `office:document-styles` content: styles, automatic styles, master pages. */
  styles?: string;
  meta?: string;
  /** Extra manifest entries, e.g. an encryption block. */
  manifest?: string;
  mimetype?: string;
}

const ODF = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/"';

/** A minimal OpenDocument text package. */
export function odtPackage(parts: OdtParts): Uint8Array {
  const entries: Record<string, string> = {
    mimetype: parts.mimetype ?? "application/vnd.oasis.opendocument.text",
    "META-INF/manifest.xml": `<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml">${parts.manifest ?? ""}</manifest:file-entry></manifest:manifest>`,
    "content.xml": `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${ODF}><office:automatic-styles>${parts.automaticStyles ?? ""}</office:automatic-styles><office:body><office:text>${parts.body}</office:text></office:body></office:document-content>`,
  };
  if (parts.styles) entries["styles.xml"] = `<?xml version="1.0" encoding="UTF-8"?><office:document-styles ${ODF}>${parts.styles}</office:document-styles>`;
  if (parts.meta) entries["meta.xml"] = `<?xml version="1.0" encoding="UTF-8"?><office:document-meta ${ODF}><office:meta>${parts.meta}</office:meta></office:document-meta>`;
  return zip(entries);
}
