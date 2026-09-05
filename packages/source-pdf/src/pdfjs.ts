/**
 * The seam between this package and pdf.js: loading the library once,
 * opening a document with safe settings, mapping its exceptions to
 * {@link PdfError}, and bounding every operation with a timeout so a hostile
 * or broken file fails instead of hanging a request.
 */
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

/** Why a PDF could not be read. */
export type PdfErrorCode =
  /** The file is encrypted and no password was given. */
  | "password-required"
  /** The file is encrypted and the password given was wrong. */
  | "wrong-password"
  /** The bytes are not a PDF, or the PDF is too damaged to open. */
  | "invalid"
  /** Reading took longer than `timeoutMs`. */
  | "timeout"
  /** pdf.js failed in a way this package does not classify. */
  | "unknown";

/** Thrown for every failure to read a PDF, with a `code` to branch on. */
export class PdfError extends Error {
  readonly code: PdfErrorCode;
  constructor(code: PdfErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PdfError";
    this.code = code;
  }
}

/** Options every reader accepts. */
export interface PdfOpenOptions {
  /** The password of an encrypted document. */
  password?: string;
  /**
   * Give up, with a `timeout` {@link PdfError}, after this many milliseconds.
   * Default 30 000. pdf.js parses in-process, so the timer is checked
   * between pages rather than mid-parse: it bounds a document with too many
   * pages to read in time, not a single page that never finishes.
   */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

let pdfjsPromise: Promise<PdfJs> | undefined;

/** Load pdf.js's legacy build on first use; the import is heavy. */
function loadPdfJs(): Promise<PdfJs> {
  pdfjsPromise ??= import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjsPromise;
}

/** Copy the caller's bytes: pdf.js takes ownership of the buffer it is given. */
export function toBytes(data: Uint8Array | ArrayBuffer): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  throw new PdfError("invalid", "Expected a Uint8Array or an ArrayBuffer of PDF bytes.");
}

function classify(error: unknown, pdfjs: PdfJs): PdfError {
  if (error instanceof PdfError) return error;
  if (error instanceof pdfjs.PasswordException) {
    const wrong = (error as { code?: number }).code === 2;
    return wrong
      ? new PdfError("wrong-password", "The PDF is encrypted and the password given is wrong.", { cause: error })
      : new PdfError("password-required", "The PDF is encrypted; pass `password` to read it.", { cause: error });
  }
  if (error instanceof pdfjs.InvalidPDFException) {
    const detail = error instanceof Error ? error.message : String(error);
    return new PdfError("invalid", `Not a readable PDF: ${detail}`, { cause: error });
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new PdfError("unknown", `Failed to read the PDF: ${detail}`, { cause: error });
}

/**
 * Run `work` against an opened document and always close it afterwards.
 * Every pdf.js failure surfaces as a {@link PdfError}; the whole call —
 * opening included — is bounded by `timeoutMs`.
 */
export async function withDocument<T>(
  data: Uint8Array | ArrayBuffer,
  options: PdfOpenOptions,
  work: (document: PDFDocumentProxy) => Promise<T>,
): Promise<T> {
  const bytes = toBytes(data);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pdfjs = await loadPdfJs();

  let task: PDFDocumentLoadingTask | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new PdfError("timeout", `Reading the PDF took longer than ${timeoutMs} ms.`));
      void task?.destroy().catch(() => undefined);
    }, timeoutMs);
  });

  const run = async (): Promise<T> => {
    task = pdfjs.getDocument({
      data: bytes,
      password: options.password,
      verbosity: pdfjs.VerbosityLevel.ERRORS,
      disableFontFace: true,
      useSystemFonts: false,
      stopAtErrors: false,
    });
    const document = await task.promise;
    return work(document);
  };

  const running = run();
  // The race reports the first failure; a second one — the task rejecting
  // after a timeout destroyed it — must not become an unhandled rejection.
  running.catch(() => undefined);
  try {
    return await Promise.race([running, timeout]);
  } catch (error) {
    throw classify(error, pdfjs);
  } finally {
    if (timer) clearTimeout(timer);
    await task?.destroy().catch(() => undefined);
  }
}

/** Parse a PDF date string (`D:YYYYMMDDHHmmSS...`) into a Date, or nothing. */
export async function parsePdfDate(value: unknown): Promise<Date | undefined> {
  if (typeof value !== "string" || !value) return undefined;
  const pdfjs = await loadPdfJs();
  const date = pdfjs.PDFDateString.toDateObject(value);
  return date && !Number.isNaN(date.getTime()) ? date : undefined;
}
