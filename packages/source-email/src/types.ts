import type { Source } from "@sembl/core";

/** A raw RFC 822 / MIME message: the bytes of an `.eml` file, or its text. */
export type RawEmail = string | Uint8Array | ArrayBuffer;

/** A mailbox as parsed from `From`, `To` or `Cc`. */
export interface EmailAddress {
  /** Display name, empty when the header had only an address. */
  name: string;
  /** The address itself. Empty for an RFC 5322 group with no address of its own. */
  address: string;
}

/** One attachment of a parsed message, bytes still undecoded. */
export interface EmailAttachment {
  /** The declared filename, or a generated one when the part had none. */
  filename: string;
  /** Lowercase media type, e.g. `application/pdf`. */
  mediaType: string;
  /** The raw bytes. */
  data: Uint8Array;
  /** True for a part shown inline by the mail client (an inline image, usually). */
  inline?: boolean;
  /** The `Content-ID`, without angle brackets, for parts the HTML body references. */
  contentId?: string;
}

/**
 * An already-parsed message, as a caller may hold one from a mail API. Header
 * names are case-insensitive; `attachments` may be omitted. This is also the
 * shape {@link ParsedEmail} extends, so the output of `parseEmail` is
 * accepted wherever an `EmailLike` is.
 */
export interface EmailLike {
  headers: Record<string, string>;
  text?: string;
  html?: string;
  attachments?: EmailAttachment[];
}

/** The structured pieces of one message. */
export interface ParsedEmail extends EmailLike {
  /** Every header, lowercase names, repeated headers joined with `, `. */
  headers: Record<string, string>;
  from?: EmailAddress;
  to: EmailAddress[];
  cc: EmailAddress[];
  subject?: string;
  /** The `Date` header as an ISO 8601 string, when it parsed. */
  date?: string;
  messageId?: string;
  inReplyTo?: string;
  /** The plain-text body, when the message has one. */
  text?: string;
  /** The HTML body, when the message has one. */
  html?: string;
  attachments: EmailAttachment[];
}

/** What every function in this package accepts as one message. */
export type EmailInput = RawEmail | EmailLike;

/** Options for {@link emailSource}, {@link emailSources} and {@link emailToText}. */
export interface EmailSourceOptions {
  /**
   * Remove quoted earlier messages — `>` lines, "On … wrote:" blocks,
   * "-----Original Message-----" blocks — keeping only the newest content.
   * A forwarded message keeps what it forwards. Default true.
   */
  stripQuotedReplies?: boolean;
  /**
   * Remove a trailing signature: everything after an RFC 3676 `-- ` line, a
   * short final block made of contact lines, a "Sent from my …" line.
   * Default true.
   */
  stripSignatures?: boolean;
  /**
   * Which headers open the source, in this order. Default
   * `From`, `To`, `Cc`, `Date`, `Subject`, `Message-ID`, `In-Reply-To`.
   * Names are matched case-insensitively; a header the message lacks is
   * skipped.
   */
  includeHeaders?: string[];
  /** The source's label. Default the subject, or "Email" when there is none. */
  label?: string;
}

/** Options for {@link threadSources}. */
export interface ThreadSourceOptions extends Omit<EmailSourceOptions, "label"> {
  /**
   * `"date"` orders messages oldest first by their `Date` header, falling
   * back to the given order when any message lacks one; `"given"` keeps the
   * order they were passed in. Default `"date"`.
   */
  order?: "date" | "given";
}

/**
 * An attachment this package does not turn into text — a PDF, an image, a
 * spreadsheet — handed back so the caller can route it to a package that
 * can. `label` matches the naming of the sources it came with.
 */
export interface RoutedAttachment {
  label: string;
  attachment: EmailAttachment;
}

/** What {@link emailSources} and {@link threadSources} return. */
export interface EmailSourcesResult {
  /** The message (or messages) and every text-like attachment, in order. */
  sources: Source[];
  /** The attachments that need another package to read. */
  attachments: RoutedAttachment[];
}
