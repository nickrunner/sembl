/**
 * A minimal zip reader for Office packages.
 *
 * `.docx` and `.odt` are zip archives of XML parts, and the only two
 * compression methods either format ever uses are "stored" and "deflate" —
 * which Node's `zlib` handles. So the container needs no dependency: walk
 * the central directory, find each part's local header, inflate. Anything
 * outside that envelope (zip64, encrypted entries, other methods) is
 * reported rather than guessed at.
 */
import { inflateRawSync } from "node:zlib";
import { DocxError } from "./errors.js";

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;

/** The magic of an OLE compound file: a legacy `.doc`, or an encrypted Office document. */
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

interface Entry {
  method: number;
  compressedSize: number;
  size: number;
  offset: number;
  encrypted: boolean;
}

/** The parts of a zip archive, read lazily by name. */
export interface ZipArchive {
  /** Every entry name in central-directory order. */
  readonly names: readonly string[];
  has(name: string): boolean;
  /** The decompressed bytes of an entry, or undefined when there is none. */
  read(name: string): Buffer | undefined;
  /** An entry decoded as UTF-8, or undefined when there is none. */
  text(name: string): string | undefined;
}

function toBuffer(data: Uint8Array | ArrayBuffer): Buffer {
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

function startsWith(buffer: Buffer, bytes: readonly number[]): boolean {
  return buffer.length >= bytes.length && bytes.every((b, i) => buffer[i] === b);
}

/** Reject what is clearly not a zip with a message that says what it is. */
function checkSignature(buffer: Buffer): void {
  if (startsWith(buffer, OLE_MAGIC)) {
    throw new DocxError(
      "encrypted",
      "This is an OLE compound file: either a password-protected document or a legacy binary .doc. Only unencrypted .docx and .odt files can be read.",
    );
  }
  if (buffer.subarray(0, 5).toString("latin1") === "{\\rtf") {
    throw new DocxError("unsupported", "This is an RTF file, not a .docx or .odt.");
  }
  if (buffer.length < 22 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new DocxError("not-a-document", "Not a Word document: the data is not a zip archive.");
  }
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const floor = Math.max(0, buffer.length - 22 - 0xffff);
  for (let i = buffer.length - 22; i >= floor; i--) {
    if (buffer.readUInt32LE(i) === END_OF_CENTRAL_DIRECTORY) return i;
  }
  throw new DocxError("malformed", "Not a Word document: the zip archive has no central directory (truncated file?).");
}

/** Open an archive from bytes. Throws {@link DocxError} for anything that is not a readable zip. */
export function openZip(data: Uint8Array | ArrayBuffer): ZipArchive {
  const buffer = toBuffer(data);
  checkSignature(buffer);

  const eocd = findEndOfCentralDirectory(buffer);
  const count = buffer.readUInt16LE(eocd + 10);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || directoryOffset === 0xffffffff) {
    throw new DocxError("unsupported", "Zip64 archives are not supported.");
  }

  const entries = new Map<string, Entry>();
  const names: string[] = [];
  let cursor = directoryOffset;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== CENTRAL_HEADER) {
      throw new DocxError("malformed", "Not a Word document: the zip central directory is corrupt.");
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const offset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    entries.set(name, { method, compressedSize, size, offset, encrypted: (flags & 1) !== 0 });
    names.push(name);
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  const cache = new Map<string, Buffer>();
  const read = (name: string): Buffer | undefined => {
    const entry = entries.get(name);
    if (!entry) return undefined;
    const cached = cache.get(name);
    if (cached) return cached;
    if (entry.encrypted) {
      throw new DocxError("encrypted", `The document part "${name}" is encrypted; remove the password and try again.`);
    }
    if (entry.compressedSize === 0xffffffff || entry.size === 0xffffffff) {
      throw new DocxError("unsupported", "Zip64 archives are not supported.");
    }
    const local = entry.offset;
    if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== LOCAL_HEADER) {
      throw new DocxError("malformed", `Not a Word document: the zip entry "${name}" has a corrupt header.`);
    }
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const end = start + entry.compressedSize;
    if (end > buffer.length) {
      throw new DocxError("malformed", `Not a Word document: the zip entry "${name}" runs past the end of the file.`);
    }
    const raw = buffer.subarray(start, end);
    let out: Buffer;
    if (entry.method === 0) {
      out = raw;
    } else if (entry.method === 8) {
      try {
        out = inflateRawSync(raw);
      } catch (error) {
        throw new DocxError("malformed", `The document part "${name}" could not be decompressed: ${(error as Error).message}`);
      }
    } else {
      throw new DocxError("unsupported", `The document part "${name}" uses zip compression method ${entry.method}; only stored and deflate are supported.`);
    }
    cache.set(name, out);
    return out;
  };

  return {
    names,
    has: (name) => entries.has(name),
    read,
    text: (name) => read(name)?.toString("utf8"),
  };
}
