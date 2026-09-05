import type { Source, SourceKind, TextSource } from "./sources.js";
import { isTextSource, sourceKind } from "./sources.js";

/**
 * Which part of an over-budget source to cut.
 *
 * - `"tail"` keeps the beginning. The default: most documents lead with what
 *   matters, and structured front-matter (a title, JSON-LD) sits there.
 * - `"head"` keeps the end, for logs and transcripts where the latest text
 *   is the relevant part.
 * - `"middle"` keeps both ends and cuts the middle, for pages that open with
 *   a summary and close with the details.
 */
export type TruncatePolicy = "tail" | "head" | "middle";

/** What was cut from one source. */
export interface TruncationRecord {
  /** The source's label, when it had one. */
  label?: string;
  /** Characters before the cut. */
  originalLength: number;
  /** Characters after it, marker included. */
  keptLength: number;
}

/** The sources after budgeting, and what happened to them. */
export interface BudgetResult<S extends Source = Source> {
  sources: S[];
  /** One record per source that was cut. Empty when everything fit. */
  truncated: TruncationRecord[];
}

/** Caps on how many binary sources a coercion sends. */
export interface BinaryLimits {
  /** Most images to send. Unbounded when absent. */
  maxImages?: number;
  /** Most documents to send. Unbounded when absent. */
  maxDocuments?: number;
}

/** One source left out for exceeding a binary cap. */
export interface DroppedSourceRecord {
  /** The source's label, when it had one. */
  label?: string;
  kind: SourceKind;
  /** Its position in the input, before anything was dropped. */
  index: number;
}

/** The sources after capping, and which ones were left out. */
export interface CapResult {
  sources: Source[];
  /** One record per source dropped, in input order. Empty when all fit. */
  dropped: DroppedSourceRecord[];
}

/**
 * Keep at most `maxImages` image sources and `maxDocuments` document sources,
 * dropping extras from the end so the sources a caller listed first — the
 * ones it presumably considers most relevant — are the ones that survive.
 * Text sources are never dropped here; they are budgeted by characters.
 */
export function capBinarySources(sources: readonly Source[], limits: BinaryLimits): CapResult {
  const { maxImages, maxDocuments } = limits;
  if (maxImages === undefined && maxDocuments === undefined) {
    return { sources: [...sources], dropped: [] };
  }
  const kept: Source[] = [];
  const dropped: DroppedSourceRecord[] = [];
  const seen: Record<SourceKind, number> = { text: 0, image: 0, document: 0 };
  sources.forEach((source, index) => {
    const kind = sourceKind(source);
    const limit = kind === "image" ? maxImages : kind === "document" ? maxDocuments : undefined;
    if (limit !== undefined && seen[kind] >= limit) {
      dropped.push({ ...(source.label !== undefined ? { label: source.label } : {}), kind, index });
      return;
    }
    seen[kind] += 1;
    kept.push(source);
  });
  return { sources: kept, dropped };
}

function omittedMarker(count: number): string {
  return `[… ${count.toLocaleString("en-US")} characters omitted …]`;
}

/** Cut one text down to `limit` characters, marker included. */
function truncateText(text: string, limit: number, policy: TruncatePolicy): string {
  if (text.length <= limit) return text;

  // The marker states the omitted count, whose digits change the marker's
  // length; a fixed-width estimate keeps the arithmetic simple and errs on
  // the short side, so the result never exceeds the limit.
  const marker = omittedMarker(text.length);
  const room = Math.max(0, limit - marker.length - 2);
  const omitted = text.length - room;
  const finalMarker = omittedMarker(omitted);

  switch (policy) {
    case "tail":
      return `${text.slice(0, room)}\n${finalMarker}`;
    case "head":
      return `${finalMarker}\n${text.slice(text.length - room)}`;
    case "middle": {
      const headRoom = Math.ceil(room / 2);
      const tailRoom = room - headRoom;
      return `${text.slice(0, headRoom)}\n${finalMarker}\n${tailRoom > 0 ? text.slice(text.length - tailRoom) : ""}`;
    }
  }
}

/**
 * Fit a set of sources into a character budget.
 *
 * A source's own `maxChars` is applied first, on its own, so a page known to
 * be huge can be capped without starving the sources beside it. Then the
 * total budget, when there is one, covers the sources' text as a whole. When they exceed it, it is
 * shared out so that every source that fits within an equal share keeps all
 * of its text, and what those leave unused goes to the longer ones. A short
 * email next to a long scraped page is therefore never touched; the page
 * takes the whole cut. A cut is marked in place with how much was omitted,
 * so the model knows the text is incomplete rather than reading a
 * mid-sentence stop as the end.
 *
 * Only text sources take part. An image or a document has no characters to
 * count and passes through in place; see {@link capBinarySources} for the
 * caps that apply to those.
 */
export function budgetSources<S extends Source>(
  sources: readonly S[],
  maxChars: number | undefined,
  policy: TruncatePolicy = "tail",
): BudgetResult<S> {
  // One record per source however many times it is cut, keyed by position.
  const records = new Map<number, TruncationRecord>();
  const record = (index: number, source: TextSource, text: string) => {
    const existing = records.get(index);
    if (existing) {
      existing.keptLength = text.length;
    } else {
      records.set(index, {
        ...(source.label !== undefined ? { label: source.label } : {}),
        originalLength: source.text.length,
        keptLength: text.length,
      });
    }
  };

  const capped: S[] = sources.map((source, index) => {
    if (!isTextSource(source)) return source;
    if (source.maxChars === undefined || source.text.length <= source.maxChars) return source;
    const text = truncateText(source.text, source.maxChars, policy);
    record(index, source, text);
    return { ...source, text } as S;
  });

  const lengthOf = (source: Source): number => (isTextSource(source) ? source.text.length : 0);
  const total = capped.reduce((sum, s) => sum + lengthOf(s), 0);
  if (maxChars === undefined || total <= maxChars) {
    return { sources: capped, truncated: [...records.values()] };
  }
  sources = capped;

  // Shortest first: each source takes the smaller of its length and an equal
  // share of what is left, so a short one's leftover flows to the longer ones.
  // Binary sources have no share to take.
  const allowance = new Map<number, number>();
  const order = sources
    .map((s, i) => i)
    .filter((i) => isTextSource(sources[i]))
    .sort((a, b) => lengthOf(sources[a]) - lengthOf(sources[b]));
  let remaining = maxChars;
  order.forEach((index, rank) => {
    const share = Math.floor(remaining / (order.length - rank));
    const granted = Math.min(lengthOf(sources[index]), share);
    allowance.set(index, granted);
    remaining -= granted;
  });

  const budgeted: S[] = sources.map((source, index) => {
    if (!isTextSource(source)) return source;
    const limit = allowance.get(index) ?? 0;
    if (source.text.length <= limit) return source;
    const text = truncateText(source.text, limit, policy);
    record(index, source, text);
    return { ...source, text } as S;
  });

  return { sources: budgeted, truncated: [...records.values()] };
}
