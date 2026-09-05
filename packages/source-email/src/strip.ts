/**
 * Heuristics for the two kinds of text a reply carries that are not its own:
 * the quoted history below it and the signature after it. Both are cut by
 * pattern, so the rules are deliberately conservative — a line of data lost
 * to an over-eager stripper costs more than a stray "Sent from my iPhone"
 * reaching the model.
 */

/** Options for {@link stripQuotedReplies}. */
export interface StripQuotedRepliesOptions {
  /**
   * Treat the message as a forward, so the first reply-style marker — an
   * Outlook "-----Original Message-----" or "From:/Sent:/To:/Subject:" block
   * — opens the forwarded content instead of closing the message. Set from
   * the subject (`Fwd:`, `FW:`) by the callers in this package.
   */
  forwarded?: boolean;
}

/** Lines that introduce a forwarded message: what follows is the point. */
const FORWARD_MARKERS = [
  /^-{2,}\s*Forwarded message\s*-{2,}$/i,
  /^Begin forwarded message:?$/i,
  /^-{2,}\s*(?:Weitergeleitete Nachricht|Message transféré|Mensaje reenviado)\s*-{2,}$/i,
];

/** Lines that mark everything after them as an earlier message, without `>`. */
const CUT_MARKERS = [
  /^-{2,}\s*Original(?: Message| Appointment)?\s*-{2,}$/i,
  /^-{2,}\s*(?:Ursprüngliche Nachricht|Message d'origine|Mensaje original)\s*-{2,}$/i,
  /^-{2,}\s*Reply above this line\s*-{2,}$/i,
  /^_{8,}$/,
];

/** The attribution line a client puts above a `>`-quoted message. */
const ATTRIBUTION = [
  /^On\b.{0,400}\bwrote:\s*$/,
  /^Le\b.{0,400}\ba écrit\s*:\s*$/,
  /^Am\b.{0,400}\bschrieb\b.{0,200}:\s*$/,
  /^El\b.{0,400}\bescribió:\s*$/,
  // Gmail without a locale: "2025-09-01 10:00 GMT+02:00 Alice <a@example.com>:"
  /^\d{4}-\d{2}-\d{2}\b.{0,200}<[^>]+@[^>]+>:\s*$/,
];

const HEADER_FROM = /^(?:From|Von|De)\s*:/i;
const HEADER_SENT = /^(?:Sent|Date|Gesendet|Envoyé|Enviado)\s*:/i;
const HEADER_SUBJECT = /^(?:Subject|Betreff|Objet|Asunto)\s*:/i;

function matchesAny(patterns: readonly RegExp[], line: string): boolean {
  return patterns.some((p) => p.test(line));
}

/**
 * Whether `lines[i]` opens an Outlook-style header block quoting the
 * previous message: `From:` with `Sent:`/`Date:` and `Subject:` within the
 * next few lines.
 */
function isHeaderBlock(lines: readonly string[], i: number): boolean {
  if (!HEADER_FROM.test(lines[i])) return false;
  const window = lines.slice(i + 1, i + 6);
  return window.some((l) => HEADER_SENT.test(l)) && window.some((l) => HEADER_SUBJECT.test(l));
}

/** A dashed rule followed by `From:` — how an attached message renders inline. */
function isInlineMessageRule(lines: readonly string[], i: number): boolean {
  return /^-{10,}$/.test(lines[i]) && i + 1 < lines.length && HEADER_FROM.test(lines[i + 1]);
}

function dequote(line: string): string {
  return line.replace(/^>\s?/, "");
}

/**
 * Remove the quoted history from a reply, keeping only what its author
 * wrote. `>`-quoted lines are dropped wherever they are, so an interleaved
 * reply keeps every answer; the "On … wrote:" line above a quote goes with
 * it; an Outlook-style "-----Original Message-----" or "From:/Sent:/To:/
 * Subject:" block ends the message, since nothing below it is new.
 *
 * A forward is the exception: after "---------- Forwarded message ----------",
 * "Begin forwarded message:" or the first reply marker of a message whose
 * subject says it is a forward, the content is kept with one level of
 * quoting removed. History quoted inside the forwarded message is still
 * dropped.
 */
export function stripQuotedReplies(text: string, options: StripQuotedRepliesOptions = {}): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let forwardMode = false;
  let forwardSeen = false;

  const enterForward = (line: string) => {
    forwardMode = true;
    forwardSeen = true;
    out.push(line);
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = forwardMode ? dequote(raw) : raw;
    const trimmed = line.trim();

    if (!forwardMode && (matchesAny(FORWARD_MARKERS, trimmed) || isInlineMessageRule(lines, i))) {
      enterForward(line);
      continue;
    }

    if (trimmed.startsWith(">")) {
      // Quoted history. Take the attribution line above it with it.
      dropTrailingAttribution(out);
      continue;
    }

    if (matchesAny(ATTRIBUTION, trimmed)) continue;
    // A two-line attribution: "On Mon, 1 Sep 2025 at 10:00, Alice" / "<a@x> wrote:".
    const next = i + 1 < lines.length ? (forwardMode ? dequote(lines[i + 1]) : lines[i + 1]).trim() : "";
    if (next && /^(?:On|Le|Am|El)\b/.test(trimmed) && matchesAny(ATTRIBUTION, `${trimmed} ${next}`)) {
      i += 1;
      continue;
    }

    // In a forward, the "From:/Sent:/Subject:" block is the forwarded message's own header: keep it.
    if (matchesAny(CUT_MARKERS, trimmed) || (!forwardMode && isHeaderBlock(lines, i))) {
      if (options.forwarded && !forwardSeen) {
        enterForward(line);
        continue;
      }
      // Nothing below a reply marker is new, inside a forward or not.
      break;
    }

    out.push(line);
  }

  return tidy(out);
}

/** Remove a trailing attribution line that had no quoted line right after it yet. */
function dropTrailingAttribution(out: string[]): void {
  for (let n = out.length - 1; n >= Math.max(0, out.length - 3); n--) {
    const candidate = out.slice(n).map((l) => l.trim()).filter(Boolean).join(" ");
    if (candidate && matchesAny(ATTRIBUTION, candidate)) {
      out.length = n;
      return;
    }
  }
}

/** A line that is nothing but a way to reach someone. */
const CONTACT_LINE = [
  /^(?:\+?\d[\d\s().-]{6,}\d)$/,
  /^(?:tel|phone|mobile|mob|cell|fax|office|direct|whatsapp|t|m|p|f)\s*[:.]\s*\+?[\d\s().-]{6,}$/i,
  /^(?:https?:\/\/|www\.)\S+$/i,
  /^(?:web|website|site|e-?mail|email|mail|e)\s*:\s*\S+$/i,
  /^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$/,
  /^(?:linkedin|twitter|x|instagram|facebook)\s*[:.]?\s*\S+$/i,
];

const SENT_FROM = /^(?:Sent from my \S+|Sent from (?:Outlook|Gmail|Mail|Yahoo Mail)\b.*|Get Outlook for \S+|Envoyé de mon \S+|Von meinem \S+ gesendet)\s*$/i;

/**
 * Remove a signature from the end of a message. Three rules, each
 * conservative:
 *
 * 1. An RFC 3676 delimiter — a line that is exactly `-- ` or `--` — ends the
 *    content; everything after it is the signature.
 * 2. A "Sent from my iPhone" / "Get Outlook for iOS" line is dropped.
 * 3. A final short block (two to six short lines, after a blank line, not
 *    the only block) in which at least one line is purely contact
 *    information — a bare phone number, URL or address, or a `Tel:` line —
 *    is dropped. A sentence that happens to contain a phone number is not a
 *    signature and is kept.
 */
export function stripSignature(text: string): string {
  let lines = text.replace(/\r\n?/g, "\n").split("\n");

  const delimiter = lines.findIndex((l) => /^-- ?$/.test(l));
  if (delimiter > 0) lines = lines.slice(0, delimiter);

  while (lines.length > 0 && (lines[lines.length - 1].trim() === "" || SENT_FROM.test(lines[lines.length - 1].trim()))) {
    lines.pop();
  }

  // The final block, delimited by the last blank line.
  let start = lines.length;
  while (start > 0 && lines[start - 1].trim() !== "") start--;
  const block = lines.slice(start).map((l) => l.trim());
  const isSentence = (l: string) => /[.!?]$/.test(l) && l.split(/\s+/).length > 4;
  const isSignatureBlock =
    start > 0 &&
    block.length >= 2 &&
    block.length <= 6 &&
    block.every((l) => l.length <= 70 && !isSentence(l)) &&
    block.some((l) => matchesAny(CONTACT_LINE, l));
  if (isSignatureBlock) lines = lines.slice(0, start);

  return tidy(lines);
}

/** Trim, drop trailing whitespace per line, collapse runs of blank lines. */
function tidy(lines: readonly string[]): string {
  return lines
    .map((l) => l.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
