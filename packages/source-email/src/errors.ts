/** Thrown when input cannot be read as an email. */
export class EmailParseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EmailParseError";
  }
}
