import type { Transcript, TranscriptSegment } from "./transcriber.js";

/**
 * Seconds as `HH:MM:SS`, the form every timestamp in a rendered source
 * takes. Always three fields so a quote of `[00:01:15]` from provenance
 * can be matched against a player position without guessing the format.
 */
export function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

/**
 * Fold consecutive segments into blocks of about `seconds` each, so a
 * transcriber that emits a line per breath does not produce a timestamp per
 * breath. A block closes when it has run for `seconds` or the speaker
 * changes; the block keeps the start of its first segment and the end of
 * its last. Segments are assumed to be in order.
 */
export function coalesceSegments(segments: readonly TranscriptSegment[], seconds: number): TranscriptSegment[] {
  if (!(seconds > 0)) return [...segments];
  const blocks: TranscriptSegment[] = [];
  let current: TranscriptSegment | undefined;
  for (const segment of segments) {
    const text = segment.text.trim();
    if (!text) continue;
    const joinable =
      current !== undefined &&
      current.speaker === segment.speaker &&
      segment.end - current.start <= seconds;
    if (current && joinable) {
      current = { ...current, end: segment.end, text: `${current.text} ${text}` };
      blocks[blocks.length - 1] = current;
    } else {
      current = { start: segment.start, end: segment.end, text };
      if (segment.speaker !== undefined) current.speaker = segment.speaker;
      blocks.push(current);
    }
  }
  return blocks;
}

/** Options for {@link renderTranscript}. */
export interface RenderOptions {
  /**
   * Prefix every segment with its start time. Defaults to true when the
   * transcript has segments; without segments there is nothing to stamp.
   */
  timestamps?: boolean;
  /** Coalesce segments into blocks of about this many seconds before rendering. */
  segmentSeconds?: number;
  /** Include the `Duration` / `Language` / `Speakers` header. Default true. */
  header?: boolean;
}

/** The distinct speakers in a transcript, in order of first appearance. */
export function speakersOf(segments: readonly TranscriptSegment[] | undefined): string[] {
  const seen = new Set<string>();
  for (const segment of segments ?? []) {
    if (segment.speaker !== undefined && segment.speaker !== "") seen.add(segment.speaker);
  }
  return [...seen];
}

/** The header lines a transcript supports — only the facts that are known. */
export function transcriptHeader(transcript: Transcript): string[] {
  const lines: string[] = [];
  if (transcript.durationSec !== undefined) lines.push(`Duration: ${formatTimestamp(transcript.durationSec)}`);
  if (transcript.language) lines.push(`Language: ${transcript.language}`);
  const speakers = speakersOf(transcript.segments);
  if (speakers.length > 0) lines.push(`Speakers: ${speakers.join(", ")}`);
  return lines;
}

/** One rendered line for a segment: `[HH:MM:SS] Speaker: text`. */
function renderSegment(segment: TranscriptSegment, timestamps: boolean): string {
  const text = segment.text.trim();
  const who = segment.speaker ? `${segment.speaker}: ` : "";
  return timestamps ? `[${formatTimestamp(segment.start)}] ${who}${text}` : `${who}${text}`;
}

/**
 * Render a transcript as the text of a source: a short header with what is
 * known about the recording, a blank line, then the speech — one line per
 * segment, each stamped with its start time, so a provenance quote can
 * name the moment a value was said.
 *
 * Without segments (or with `timestamps: false` and no speakers) the body
 * is the transcript's own prose.
 */
export function renderTranscript(transcript: Transcript, options: RenderOptions = {}): string {
  const { header = true, segmentSeconds } = options;
  const hasSegments = (transcript.segments?.length ?? 0) > 0;
  const timestamps = options.timestamps ?? hasSegments;

  let body: string;
  if (hasSegments && (timestamps || speakersOf(transcript.segments).length > 0)) {
    const segments = segmentSeconds
      ? coalesceSegments(transcript.segments!, segmentSeconds)
      : transcript.segments!.filter((s) => s.text.trim());
    body = segments.map((s) => renderSegment(s, timestamps)).join("\n");
  } else {
    body = transcript.text.trim();
  }

  const head = header ? transcriptHeader(transcript) : [];
  return head.length > 0 ? `${head.join("\n")}\n\n${body}` : body;
}

const STAMP = /^\[(\d{2}):(\d{2}):(\d{2})\]/;

/**
 * Whether a quote that runs past the end of a line begins inside it: some
 * prefix of the quote, at least a few words long, is the line's tail.
 */
function startsInLine(lineText: string, wanted: string): boolean {
  const words = wanted.split(" ");
  for (let n = words.length - 1; n >= 2; n--) {
    const prefix = words.slice(0, n).join(" ");
    if (prefix.length < 12) return false;
    if (lineText.endsWith(prefix)) return true;
  }
  return false;
}

function normalise(text: string): string {
  return text.replace(/[\s ]+/g, " ").replace(/[“”]/g, '"').replace(/[‘’]/g, "'").trim().toLowerCase();
}

/**
 * Where in a rendered source a provenance quote was said: the start time
 * of the stamped line that contains it. A quote is matched after
 * collapsing whitespace, case and curly quotes; one that spans lines is
 * located by its opening words. Returns `undefined` when the quote is not
 * in the text, or the line it is on carries no stamp.
 *
 * This is the deterministic route to a time. Asking the model to keep the
 * stamp on its quotes instead was tried and dropped: it interpolates
 * plausible ones (`[00:00:07]` for a line stamped `[00:00:00]`), so a
 * stamp at the front of a quote is ignored here and the line's own is used.
 *
 * ```ts
 * const at = evidenceTimestamp(source.text, provenance.nightlyRate.evidence);
 * // → { seconds: 22, timestamp: "00:00:22", line: "[00:00:22] Marta: I'm thinking two forty a night…" }
 * ```
 */
export function evidenceTimestamp(
  sourceText: string,
  evidence: string | undefined,
): { seconds: number; timestamp: string; line: string } | undefined {
  if (!evidence) return undefined;
  const wanted = normalise(evidence.replace(STAMP, ""));
  if (!wanted) return undefined;
  const lines = sourceText.split("\n");
  const stamped = lines.map((line) => ({ line, stamp: STAMP.exec(line), text: normalise(line) })).filter((l) => l.stamp);
  const hit = stamped.find((l) => l.text.includes(wanted)) ?? stamped.find((l) => startsInLine(l.text, wanted));
  if (!hit || !hit.stamp) return undefined;
  const [, h, m, s] = hit.stamp;
  const seconds = Number(h) * 3600 + Number(m) * 60 + Number(s);
  return { seconds, timestamp: `${h}:${m}:${s}`, line: hit.line };
}
