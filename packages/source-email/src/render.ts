import { decodeWords } from "postal-mime";
import { emailHtmlToText } from "./html.js";
import { stripQuotedReplies, stripSignature } from "./strip.js";
import type { EmailAddress, EmailAttachment, EmailSourceOptions, ParsedEmail } from "./types.js";

/** The headers a source opens with unless `includeHeaders` says otherwise. */
export const DEFAULT_HEADERS = ["From", "To", "Cc", "Date", "Subject", "Message-ID", "In-Reply-To"] as const;

/** A subject that says the message forwards another. */
const FORWARD_SUBJECT = /^\s*(?:fwd?|wg|tr|rv|enc)\s*:/i;

/** `Name <address>`, or whichever half there is. */
export function formatAddress(address: EmailAddress): string {
  if (address.name && address.address) return `${address.name} <${address.address}>`;
  return address.name || address.address;
}

/** `812 B`, `24 KB`, `1.3 MB`. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The line an attachment gets in the header block. */
export function describeAttachment(attachment: EmailAttachment): string {
  const kind = attachment.inline && attachment.mediaType.startsWith("image/") ? "Inline image" : "Attachment";
  return `${kind}: ${attachment.filename} (${attachment.mediaType}, ${formatSize(attachment.data.byteLength)})`;
}

/** The value of one header, decoded, from the parsed fields where they are richer. */
function headerValue(email: ParsedEmail, name: string): string | undefined {
  switch (name.toLowerCase()) {
    case "from":
      return email.from ? formatAddress(email.from) : undefined;
    case "to":
      return email.to.length ? email.to.map(formatAddress).join(", ") : undefined;
    case "cc":
      return email.cc.length ? email.cc.map(formatAddress).join(", ") : undefined;
    case "subject":
      return email.subject;
    case "message-id":
      return email.messageId;
    case "in-reply-to":
      return email.inReplyTo;
    default: {
      const raw = email.headers[name.toLowerCase()];
      return raw?.trim() ? decodeWords(raw).replace(/\s+/g, " ").trim() : undefined;
    }
  }
}

/** Whether the subject marks the message as a forward. */
export function isForward(email: ParsedEmail): boolean {
  return FORWARD_SUBJECT.test(email.subject ?? "");
}

/**
 * The message's own content as text: the plain-text part when there is
 * one, otherwise the HTML part converted; then, by default, quoted history
 * and the signature removed.
 */
export function emailBody(email: ParsedEmail, options: EmailSourceOptions = {}): string {
  const { stripQuotedReplies: stripQuotes = true, stripSignatures = true } = options;
  let body = email.text?.trim()
    ? email.text.replace(/\r\n?/g, "\n").trim()
    : email.html?.trim()
      ? emailHtmlToText(email.html)
      : "";
  if (stripQuotes) body = stripQuotedReplies(body, { forwarded: isForward(email) });
  if (stripSignatures) body = stripSignature(body);
  return body.trim();
}

/**
 * Render a message as one block of text: the chosen headers, one line per
 * attachment, a blank line, then the body. Headers go first because SEMBL's
 * default truncation keeps the head of a source — on a message that blows
 * the budget, who sent it and when survive.
 */
export function emailToText(email: ParsedEmail, options: EmailSourceOptions = {}): string {
  const names = options.includeHeaders ?? [...DEFAULT_HEADERS];
  const head: string[] = [];
  for (const name of names) {
    const value = headerValue(email, name);
    if (value) head.push(`${name}: ${value}`);
  }
  for (const attachment of email.attachments) head.push(describeAttachment(attachment));

  const body = emailBody(email, options);
  return [head.join("\n"), body].filter((s) => s.length > 0).join("\n\n");
}
