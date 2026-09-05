/**
 * A minimal PDF writer for test fixtures: uncompressed streams, the standard
 * Helvetica font, optional document info, an optional image-only page and
 * optional 40-bit RC4 encryption (the classic "standard security handler",
 * revision 2). Nothing here is meant for production PDFs — it exists so the
 * tests can build small, licence-free documents in memory instead of
 * checking binaries in.
 */
import { createHash } from "node:crypto";

/** One run of text at a position, in PDF user space (origin bottom-left). */
export interface TextRun {
  x: number;
  y: number;
  text: string;
  /** Font size in points. Default 12. */
  size?: number;
}

/** A page: either text runs or an image-only page (a "scan"). */
export type PageSpec = { text: TextRun[] } | { image: true };

export interface PdfInfo {
  Title?: string;
  Author?: string;
  Subject?: string;
  Keywords?: string;
  CreationDate?: string;
  ModDate?: string;
}

export interface PdfSpec {
  pages: PageSpec[];
  info?: PdfInfo;
  /** Encrypt with this user password (RC4 40-bit, revision 2). */
  userPassword?: string;
  ownerPassword?: string;
}

const latin1 = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

const PAD = Uint8Array.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

function md5(...parts: Uint8Array[]): Uint8Array {
  const hash = createHash("md5");
  for (const part of parts) hash.update(part);
  return new Uint8Array(hash.digest());
}

function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const s = Uint8Array.from({ length: 256 }, (_, i) => i);
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = new Uint8Array(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 0xff;
    j = (j + s[i]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
    out[k] = data[k] ^ s[(s[i] + s[j]) & 0xff];
  }
  return out;
}

function padPassword(password: string): Uint8Array {
  const bytes = latin1(password);
  const out = new Uint8Array(32);
  out.set(bytes.subarray(0, 32));
  out.set(PAD.subarray(0, 32 - Math.min(32, bytes.length)), Math.min(32, bytes.length));
  return out;
}

function escapePdfString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

interface Encryption {
  key: Uint8Array;
  O: Uint8Array;
  U: Uint8Array;
  P: number;
}

function setupEncryption(userPassword: string, ownerPassword: string, id: Uint8Array): Encryption {
  const P = -1; // all permissions
  const ownerKey = md5(padPassword(ownerPassword || userPassword)).subarray(0, 5);
  const O = rc4(ownerKey, padPassword(userPassword));
  const pBytes = Uint8Array.from([P & 0xff, (P >> 8) & 0xff, (P >> 16) & 0xff, (P >>> 24) & 0xff]);
  const key = md5(padPassword(userPassword), O, pBytes, id).subarray(0, 5);
  const U = rc4(key, PAD);
  return { key, O, U, P };
}

function objectKey(enc: Encryption, num: number, gen: number): Uint8Array {
  const extra = Uint8Array.from([num & 0xff, (num >> 8) & 0xff, (num >> 16) & 0xff, gen & 0xff, (gen >> 8) & 0xff]);
  return md5(enc.key, extra).subarray(0, Math.min(enc.key.length + 5, 16));
}

/** Build a PDF as bytes. */
export function makePdf(spec: PdfSpec): Uint8Array {
  const id = md5(latin1(JSON.stringify(spec)));
  const enc = spec.userPassword !== undefined ? setupEncryption(spec.userPassword, spec.ownerPassword ?? "", id) : undefined;

  // Object numbers: 1 catalog, 2 pages, 3 font, 4 image, 5 info, then per page: page, contents.
  const objects: Array<{ num: number; body: Uint8Array }> = [];
  const pageObjects: number[] = [];
  let next = 6;

  const encryptBytes = (num: number, data: Uint8Array): Uint8Array => (enc ? rc4(objectKey(enc, num, 0), data) : data);
  const pdfString = (num: number, value: string): string =>
    enc ? `<${hex(encryptBytes(num, latin1(value)))}>` : `(${escapePdfString(value)})`;
  const stream = (num: number, dict: string, data: Uint8Array): Uint8Array => {
    const body = encryptBytes(num, data);
    return concat([latin1(`<< ${dict} /Length ${body.length} >>\nstream\n`), body, latin1("\nendstream")]);
  };

  for (const page of spec.pages) {
    const pageNum = next++;
    const contentNum = next++;
    pageObjects.push(pageNum);
    let content: string;
    let resources: string;
    if ("image" in page) {
      content = "q 200 0 0 200 100 500 cm /Im1 Do Q";
      resources = "<< /XObject << /Im1 4 0 R >> >>";
    } else {
      content = page.text
        .map((run) => `BT /F1 ${run.size ?? 12} Tf ${run.x} ${run.y} Td (${escapePdfString(run.text)}) Tj ET`)
        .join("\n");
      resources = "<< /Font << /F1 3 0 R >> >>";
    }
    objects.push({
      num: pageNum,
      body: latin1(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources ${resources} /Contents ${contentNum} 0 R >>`,
      ),
    });
    objects.push({ num: contentNum, body: stream(contentNum, "", latin1(content)) });
  }

  objects.unshift(
    { num: 1, body: latin1("<< /Type /Catalog /Pages 2 0 R >>") },
    {
      num: 2,
      body: latin1(`<< /Type /Pages /Kids [${pageObjects.map((n) => `${n} 0 R`).join(" ")}] /Count ${pageObjects.length} >>`),
    },
    { num: 3, body: latin1("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>") },
    {
      num: 4,
      body: stream(
        4,
        "/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8",
        Uint8Array.from([0x00, 0xff, 0xff, 0x00]),
      ),
    },
  );

  const info = spec.info ?? {};
  const infoEntries = Object.entries(info)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `/${k} ${pdfString(5, v as string)}`);
  objects.push({ num: 5, body: latin1(`<< ${infoEntries.join(" ")} >>`) });

  let encryptNum: number | undefined;
  if (enc) {
    encryptNum = next++;
    objects.push({
      num: encryptNum,
      body: latin1(
        `<< /Filter /Standard /V 1 /R 2 /Length 40 /P ${enc.P} /O <${hex(enc.O)}> /U <${hex(enc.U)}> >>`,
      ),
    });
  }

  objects.sort((a, b) => a.num - b.num);
  const parts: Uint8Array[] = [latin1("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")];
  const offsets: number[] = [];
  let length = parts[0].length;
  for (const object of objects) {
    offsets[object.num] = length;
    const chunk = concat([latin1(`${object.num} 0 obj\n`), object.body, latin1("\nendobj\n")]);
    parts.push(chunk);
    length += chunk.length;
  }
  const count = objects.length + 1;
  const xrefLines = ["0000000000 65535 f "];
  for (let n = 1; n < count; n++) xrefLines.push(`${String(offsets[n]).padStart(10, "0")} 00000 n `);
  const trailer =
    `<< /Size ${count} /Root 1 0 R /Info 5 0 R /ID [<${hex(id)}> <${hex(id)}>]` +
    (encryptNum ? ` /Encrypt ${encryptNum} 0 R` : "") +
    " >>";
  parts.push(latin1(`xref\n0 ${count}\n${xrefLines.join("\n")}\ntrailer\n${trailer}\nstartxref\n${length}\n%%EOF\n`));
  return concat(parts);
}

/** Lay out lines of text top-down on a page, 16pt apart, starting near the top. */
export function textPage(lines: string[], options: { size?: number; x?: number; top?: number; gap?: number } = {}): PageSpec {
  const { size = 12, x = 72, top = 720, gap = 16 } = options;
  return { text: lines.map((text, i) => ({ x, y: top - i * gap, text, size })) };
}
