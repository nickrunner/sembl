import type { Source } from "./sources.js";

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
export interface BudgetResult {
  sources: Source[];
  /** One record per source that was cut. Empty when everything fit. */
  truncated: TruncationRecord[];
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
 * The budget covers the sources' text as a whole. When they exceed it, it is
 * shared out so that every source that fits within an equal share keeps all
 * of its text, and what those leave unused goes to the longer ones. A short
 * email next to a long scraped page is therefore never touched; the page
 * takes the whole cut. A cut is marked in place with how much was omitted,
 * so the model knows the text is incomplete rather than reading a
 * mid-sentence stop as the end.
 */
export function budgetSources(
  sources: readonly Source[],
  maxChars: number,
  policy: TruncatePolicy = "tail",
): BudgetResult {
  const total = sources.reduce((sum, s) => sum + s.text.length, 0);
  if (total <= maxChars) {
    return { sources: [...sources], truncated: [] };
  }

  // Shortest first: each source takes the smaller of its length and an equal
  // share of what is left, so a short one's leftover flows to the longer ones.
  const allowance = new Map<number, number>();
  const order = sources.map((s, i) => i).sort((a, b) => sources[a].text.length - sources[b].text.length);
  let remaining = maxChars;
  order.forEach((index, rank) => {
    const share = Math.floor(remaining / (order.length - rank));
    const granted = Math.min(sources[index].text.length, share);
    allowance.set(index, granted);
    remaining -= granted;
  });

  const truncated: TruncationRecord[] = [];
  const budgeted = sources.map((source, index) => {
    const limit = allowance.get(index) ?? 0;
    if (source.text.length <= limit) return source;
    const text = truncateText(source.text, limit, policy);
    truncated.push({
      ...(source.label !== undefined ? { label: source.label } : {}),
      originalLength: source.text.length,
      keptLength: text.length,
    });
    return { ...source, text };
  });

  return { sources: budgeted, truncated };
}
