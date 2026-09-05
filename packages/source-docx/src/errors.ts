/** Why a document could not be read. */
export type DocxErrorCode =
  /** The bytes are not a zip archive — not a `.docx`/`.odt` at all. */
  | "not-a-document"
  /** A password-protected document, or a zip with encrypted entries. */
  | "encrypted"
  /** A format this package does not read: legacy `.doc`, RTF, zip64, … */
  | "unsupported"
  /** A zip that is a document but whose parts are broken or missing. */
  | "malformed";

/**
 * Thrown for input this package cannot turn into text. The `code` says
 * which kind of problem it was, so a caller can tell "ask for a password"
 * apart from "this is not a Word document".
 */
export class DocxError extends Error {
  readonly code: DocxErrorCode;

  constructor(code: DocxErrorCode, message: string) {
    super(message);
    this.name = "DocxError";
    this.code = code;
  }
}
