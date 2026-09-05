import PostalMime from "postal-mime";
import type { Address as PostalAddress, Attachment as PostalAttachment } from "postal-mime";
import { EmailParseError } from "./errors.js";
import type { EmailAddress, EmailAttachment, EmailInput, EmailLike, ParsedEmail, RawEmail } from "./types.js";

/**
 * Headers whose presence says "this is a message". Malformed input parses
 * without error as a pile of nonsense headers, so at least one of these has
 * to be there before the result is trusted.
 */
const RECOGNISED_HEADERS = [
  "from", "to", "cc", "subject", "date", "message-id", "content-type", "mime-version",
  "received", "return-path", "delivered-to", "reply-to", "sender", "in-reply-to", "references",
];

/** Whether a value is a raw message rather than an already-parsed one. */
export function isRawEmail(input: unknown): input is RawEmail {
  return typeof input === "string" || input instanceof Uint8Array || input instanceof ArrayBuffer;
}

/** Whether a value has the shape of an {@link EmailLike}. */
export function isEmailLike(input: unknown): input is EmailLike {
  return (
    typeof input === "object" &&
    input !== null &&
    typeof (input as EmailLike).headers === "object" &&
    (input as EmailLike).headers !== null
  );
}

function stripBrackets(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/^<|>$/g, "") : undefined;
}

/** Flatten postal-mime's address list (groups included) to mailboxes. */
function toAddresses(list: PostalAddress[] | undefined): EmailAddress[] {
  const out: EmailAddress[] = [];
  for (const entry of list ?? []) {
    if (entry.group) {
      for (const member of entry.group) out.push({ name: member.name ?? "", address: member.address ?? "" });
    } else {
      out.push({ name: entry.name ?? "", address: entry.address ?? "" });
    }
  }
  return out;
}

const EXTENSIONS: Record<string, string> = {
  "text/plain": "txt", "text/markdown": "md", "text/csv": "csv", "text/html": "html",
  "text/calendar": "ics", "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg",
  "image/gif": "gif", "image/webp": "webp", "message/rfc822": "eml",
};

function toBytes(content: PostalAttachment["content"]): Uint8Array {
  if (typeof content === "string") return new TextEncoder().encode(content);
  return content instanceof Uint8Array ? content : new Uint8Array(content);
}

function toAttachment(part: PostalAttachment, index: number): EmailAttachment {
  const mediaType = (part.mimeType || "application/octet-stream").toLowerCase();
  const filename = part.filename?.trim() || `attachment-${index + 1}.${EXTENSIONS[mediaType] ?? "bin"}`;
  const attachment: EmailAttachment = { filename, mediaType, data: toBytes(part.content) };
  if (part.disposition === "inline" || part.related) attachment.inline = true;
  const contentId = stripBrackets(part.contentId);
  if (contentId) attachment.contentId = contentId;
  return attachment;
}

/** Parse the `Date` header's value to ISO 8601, or leave it out. */
function isoDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

/** Parse a comma-separated address header without the MIME parser. */
function parseAddressHeader(value: string | undefined): EmailAddress[] {
  if (!value) return [];
  const out: EmailAddress[] = [];
  for (const raw of value.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)) {
    const part = raw.trim();
    if (!part) continue;
    const match = /^(?:"?([^"<]*?)"?\s*)?<([^>]+)>$/.exec(part);
    if (match) out.push({ name: (match[1] ?? "").trim(), address: match[2].trim() });
    else out.push({ name: "", address: part });
  }
  return out;
}

/** Complete an {@link EmailLike} into a {@link ParsedEmail} from its headers. */
function fromEmailLike(input: EmailLike): ParsedEmail {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers)) {
    if (typeof value === "string") headers[name.toLowerCase()] = value;
  }
  const attachments = (input.attachments ?? []).map((a, i) => ({
    ...a,
    filename: a.filename?.trim() || `attachment-${i + 1}.${EXTENSIONS[a.mediaType] ?? "bin"}`,
    mediaType: (a.mediaType || "application/octet-stream").toLowerCase(),
    data: a.data instanceof Uint8Array ? a.data : new Uint8Array(a.data as ArrayBuffer),
  }));
  const [from] = parseAddressHeader(headers.from);
  const parsed: ParsedEmail = {
    headers,
    to: parseAddressHeader(headers.to),
    cc: parseAddressHeader(headers.cc),
    attachments,
  };
  if (from) parsed.from = from;
  if (headers.subject?.trim()) parsed.subject = headers.subject.trim();
  const date = isoDate(headers.date);
  if (date) parsed.date = date;
  const messageId = stripBrackets(headers["message-id"]);
  if (messageId) parsed.messageId = messageId;
  const inReplyTo = stripBrackets(headers["in-reply-to"]);
  if (inReplyTo) parsed.inReplyTo = inReplyTo;
  if (typeof input.text === "string") parsed.text = input.text;
  if (typeof input.html === "string") parsed.html = input.html;
  return parsed;
}

/**
 * Parse a raw message — the bytes or text of an `.eml` — into its pieces:
 * headers, the sender and recipients, the text and HTML bodies decoded from
 * whatever charset they were sent in, and every attachment as bytes.
 *
 * A `message/rfc822` part (a forwarded message attached whole) is rendered
 * into the text body, since the forwarded content is usually the point. An
 * already-parsed {@link EmailLike} passes through with its convenience
 * fields filled in from its headers.
 *
 * Throws {@link EmailParseError} when the input has no recognisable message
 * headers at all: the parser is lenient by design, so this is the line
 * between "an odd email" and "not an email".
 */
export async function parseEmail(input: EmailInput): Promise<ParsedEmail> {
  if (isEmailLike(input)) return fromEmailLike(input);
  if (!isRawEmail(input)) {
    throw new EmailParseError("Expected a raw message (string or bytes) or an object with headers");
  }
  const empty = typeof input === "string" ? input.trim().length === 0 : input.byteLength === 0;
  if (empty) throw new EmailParseError("Cannot parse an empty message");

  let mail;
  try {
    mail = await PostalMime.parse(input);
  } catch (cause) {
    throw new EmailParseError(`Could not parse the message: ${(cause as Error)?.message ?? String(cause)}`, { cause });
  }

  const headers: Record<string, string> = {};
  for (const { key, value } of mail.headers) {
    headers[key] = key in headers ? `${headers[key]}, ${value}` : value;
  }
  if (!RECOGNISED_HEADERS.some((name) => name in headers)) {
    throw new EmailParseError(
      "Input does not look like an RFC 822 message: no From, To, Subject, Date, Message-ID or Content-Type header found",
    );
  }

  const parsed: ParsedEmail = {
    headers,
    to: toAddresses(mail.to),
    cc: toAddresses(mail.cc),
    attachments: mail.attachments.map(toAttachment),
  };
  const [from] = toAddresses(mail.from ? [mail.from] : []);
  if (from) parsed.from = from;
  if (mail.subject?.trim()) parsed.subject = mail.subject.trim();
  const date = isoDate(mail.date);
  if (date) parsed.date = date;
  const messageId = stripBrackets(mail.messageId);
  if (messageId) parsed.messageId = messageId;
  const inReplyTo = stripBrackets(mail.inReplyTo);
  if (inReplyTo) parsed.inReplyTo = inReplyTo;
  if (mail.text) parsed.text = mail.text;
  if (mail.html) parsed.html = mail.html;
  return parsed;
}
