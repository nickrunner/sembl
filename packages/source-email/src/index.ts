import type { TextSource } from "@sembl/core";
import { pageToText } from "@sembl/source-html";
import { EmailParseError } from "./errors.js";
import { splitMbox } from "./mbox.js";
import { parseEmail } from "./parse.js";
import { emailToText, formatAddress } from "./render.js";
import type {
  EmailAttachment,
  EmailInput,
  EmailSourceOptions,
  EmailSourcesResult,
  ParsedEmail,
  RoutedAttachment,
  ThreadSourceOptions,
} from "./types.js";

export { parseEmail } from "./parse.js";
export { emailToText, emailBody, formatAddress, formatSize, describeAttachment, DEFAULT_HEADERS } from "./render.js";
export { stripQuotedReplies, stripSignature } from "./strip.js";
export type { StripQuotedRepliesOptions } from "./strip.js";
export { emailHtmlToText } from "./html.js";
export { splitMbox } from "./mbox.js";
export { EmailParseError } from "./errors.js";
export type {
  EmailAddress,
  EmailAttachment,
  EmailInput,
  EmailLike,
  EmailSourceOptions,
  EmailSourcesResult,
  ParsedEmail,
  RawEmail,
  RoutedAttachment,
  ThreadSourceOptions,
} from "./types.js";

/** Attachments this package can read as text, by extension and by media type. */
const TEXT_EXTENSIONS: Record<string, "text" | "html"> = {
  txt: "text", text: "text", md: "text", markdown: "text", csv: "text", tsv: "text", html: "html", htm: "html",
};
const TEXT_TYPES: Record<string, "text" | "html"> = {
  "text/plain": "text", "text/markdown": "text", "text/csv": "text", "text/tab-separated-values": "text", "text/html": "html",
};

/** Whether — and how — an attachment can become a source of its own. */
function textKind(attachment: EmailAttachment): "text" | "html" | undefined {
  if (attachment.inline && attachment.mediaType.startsWith("image/")) return undefined;
  const extension = /\.([a-z0-9]+)$/i.exec(attachment.filename)?.[1]?.toLowerCase();
  return (extension && TEXT_EXTENSIONS[extension]) || TEXT_TYPES[attachment.mediaType];
}

/**
 * Decode bytes as text. The MIME parser hands attachments back undecoded,
 * so: honour a byte-order mark, otherwise try strict UTF-8, otherwise fall
 * back to Windows-1252, which reads every byte as something.
 */
function decodeText(data: Uint8Array): string {
  if (data.length >= 2 && ((data[0] === 0xff && data[1] === 0xfe) || (data[0] === 0xfe && data[1] === 0xff))) {
    return new TextDecoder(data[0] === 0xff ? "utf-16le" : "utf-16be").decode(data);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return new TextDecoder("windows-1252").decode(data);
  }
}

/** The label a message gets when the caller gave none. */
function defaultLabel(email: ParsedEmail): string {
  return email.subject?.trim() || "Email";
}

/** One message's sources and the attachments to route, under a label. */
function sourcesFor(email: ParsedEmail, label: string, options: EmailSourceOptions): EmailSourcesResult {
  const sources: TextSource[] = [{ label, text: emailToText(email, { ...options, label }) }];
  const attachments: RoutedAttachment[] = [];
  for (const attachment of email.attachments) {
    const attachmentLabel = `${label}: attachment ${attachment.filename}`;
    const kind = textKind(attachment);
    if (kind === undefined) {
      attachments.push({ label: attachmentLabel, attachment });
      continue;
    }
    const decoded = decodeText(attachment.data);
    const text = kind === "html" ? pageToText(decoded) : decoded.replace(/\r\n?/g, "\n").trim();
    if (text) sources.push({ label: attachmentLabel, text });
  }
  return { sources, attachments };
}

/**
 * A message as one labelled source: its headers, one line per attachment,
 * then its own content — the plain-text part, or the HTML part converted
 * — with quoted history and the signature stripped unless told otherwise.
 * The label defaults to the subject.
 *
 * Attachments are listed, not read. For their contents use
 * {@link emailSources}.
 */
export async function emailSource(input: EmailInput, options: EmailSourceOptions = {}): Promise<TextSource> {
  const email = await parseEmail(input);
  return { label: options.label ?? defaultLabel(email), text: emailToText(email, options) };
}

/**
 * A message as several sources: the message itself (as {@link emailSource}
 * renders it), then one source per text-like attachment — `.txt`, `.md`,
 * `.csv` as they are, `.html` through `@sembl/source-html`. Every other
 * attachment — a PDF, an image, a spreadsheet — is listed in the message
 * source and returned in `attachments` with its bytes, so the caller can
 * hand it to a package that reads that kind and add the result to the same
 * coercion:
 *
 * ```ts
 * const { sources, attachments } = await emailSources(eml);
 * for (const { label, attachment } of attachments) {
 *   if (attachment.mediaType === "application/pdf") sources.push(await pdfSource(attachment.data, label));
 * }
 * const listing = await coerce<Listing>(sources, { provider, schema });
 * ```
 *
 * Inline images come back in `attachments` too, flagged `inline`, so a
 * photo pasted into the message is not lost; a signature logo is easy to
 * skip on size or on the flag.
 */
export async function emailSources(input: EmailInput, options: EmailSourceOptions = {}): Promise<EmailSourcesResult> {
  const email = await parseEmail(input);
  return sourcesFor(email, options.label ?? defaultLabel(email), options);
}

/** `Message 2 from Alice Nguyen on 2025-09-01`, or as much of that as the message states. */
function threadLabel(email: ParsedEmail, n: number): string {
  const sender = email.from ? email.from.name || email.from.address : "";
  const date = email.date?.slice(0, 10);
  return `Message ${n}${sender ? ` from ${sender}` : ""}${date ? ` on ${date}` : ""}`;
}

/**
 * A thread as ordered sources, oldest first, each message labelled
 * "Message N from <sender> on <date>". Quoted history is stripped from
 * every message, so each contributes only what its author wrote and the
 * model reads the conversation once rather than N times over. Text-like
 * attachments follow the message they came with; the rest are returned for
 * routing, as in {@link emailSources}.
 *
 * Takes an array of messages — raw or parsed — or a single mbox string.
 */
export async function threadSources(
  messages: readonly EmailInput[] | string,
  options: ThreadSourceOptions = {},
): Promise<EmailSourcesResult> {
  const inputs = typeof messages === "string" ? splitMbox(messages) : [...messages];
  if (inputs.length === 0) throw new EmailParseError("A thread needs at least one message");
  const { order = "date", ...rest } = options;

  const parsed = await Promise.all(inputs.map((input) => parseEmail(input)));
  const ordered = order === "date" && parsed.every((m) => m.date)
    ? [...parsed].sort((a, b) => Date.parse(a.date!) - Date.parse(b.date!))
    : parsed;

  const result: EmailSourcesResult = { sources: [], attachments: [] };
  ordered.forEach((email, i) => {
    const part = sourcesFor(email, threadLabel(email, i + 1), rest);
    result.sources.push(...part.sources);
    result.attachments.push(...part.attachments);
  });
  return result;
}

// Re-exported for callers that build labels or list attachments themselves.
export { formatAddress as formatEmailAddress };
