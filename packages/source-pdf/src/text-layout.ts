/**
 * Turn the positioned text runs pdf.js reports for a page back into lines.
 *
 * A PDF has no notion of a line or a paragraph: it places runs of glyphs at
 * coordinates, and a producer is free to emit them in any order. This pass
 * groups runs by baseline, orders each line left to right, spaces the runs
 * by the geometry between them, and separates paragraphs by the vertical
 * gap between lines. It is pure — no pdf.js — so it can be tested with
 * hand-made runs.
 *
 * Known limits: multi-column text reads across the columns rather than down
 * them (the gap between columns is kept, as a run of spaces), and rotated
 * text is grouped by its baseline as if it were horizontal.
 */

/** A run of text on a page, in PDF user space (origin bottom-left). */
export interface TextRun {
  /** The text itself. */
  str: string;
  /** Left edge of the run. */
  x: number;
  /** Baseline of the run. */
  y: number;
  /** Advance width of the run. */
  width: number;
  /** Font size, used as the unit for gaps. */
  fontSize: number;
}

interface Line {
  baseline: number;
  fontSize: number;
  runs: TextRun[];
}

/** A run of text as pdf.js reports it — the fields this pass reads. */
export interface PdfTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

/** Convert pdf.js text items to runs, dropping the synthetic whitespace it inserts. */
export function itemsToRuns(items: ReadonlyArray<PdfTextItem | { type: string }>): TextRun[] {
  const runs: TextRun[] = [];
  for (const item of items) {
    if (!("str" in item)) continue; // marked-content markers carry no text
    if (item.str.trim() === "") continue; // pdf.js's own gap heuristics; the geometry below replaces them
    const [a, b, , , x, y] = item.transform;
    const fontSize = Math.hypot(a, b) || item.height || 1;
    runs.push({ str: item.str, x, y, width: item.width, fontSize });
  }
  return runs;
}

/**
 * Assemble runs into text. Runs whose baselines are within half a font size
 * of each other share a line; lines are ordered top to bottom and runs left
 * to right. Inside a line a gap wider than a fifth of the font size becomes
 * a space and a gap wider than one and a half font sizes — a table column or
 * a text column — becomes two, so a row of cells stays on one line with its
 * cells visibly apart. A vertical gap of more than 1.6 line heights becomes
 * a blank line.
 */
export function runsToText(runs: readonly TextRun[]): string {
  const lines: Line[] = [];
  for (const run of runs) {
    const tolerance = Math.max(run.fontSize, 1) * 0.5;
    let line = lines.find((l) => Math.abs(l.baseline - run.y) <= Math.max(tolerance, l.fontSize * 0.5));
    if (!line) {
      line = { baseline: run.y, fontSize: run.fontSize, runs: [] };
      lines.push(line);
    }
    line.runs.push(run);
    line.fontSize = Math.max(line.fontSize, run.fontSize);
  }

  lines.sort((a, b) => b.baseline - a.baseline);

  const out: string[] = [];
  let previous: Line | undefined;
  for (const line of lines) {
    if (previous) {
      const gap = previous.baseline - line.baseline;
      const leading = Math.max(previous.fontSize, line.fontSize);
      if (gap > leading * 1.6) out.push("");
    }
    out.push(lineToText(line));
    previous = line;
  }
  return out.join("\n").trim();
}

function lineToText(line: Line): string {
  const runs = [...line.runs].sort((a, b) => a.x - b.x);
  let text = "";
  let cursor = Number.NEGATIVE_INFINITY;
  for (const run of runs) {
    if (text) {
      const gap = run.x - cursor;
      const unit = Math.max(run.fontSize, 1);
      const joined = /\s$/.test(text) || /^\s/.test(run.str);
      if (!joined) {
        if (gap > unit * 1.5) text += "  ";
        else if (gap > unit * 0.2) text += " ";
      }
    }
    text += run.str;
    cursor = Math.max(cursor, run.x + run.width);
  }
  return text.replace(/[ \t]+$/g, "").replace(/\s{3,}/g, "  ");
}

/** The whole pass: pdf.js text items in, page text out. */
export function itemsToText(items: ReadonlyArray<PdfTextItem | { type: string }>): string {
  return runsToText(itemsToRuns(items));
}
