/**
 * A small CSV/TSV parser in the spirit of RFC 4180, with the leniencies real
 * exports need: any of `\n`, `\r\n` or `\r` as a record break, a delimiter
 * that is detected when not given, a leading byte-order mark dropped, quoted
 * fields that span lines, and `""` inside quotes as a literal quote. Text
 * after a closing quote and before the next delimiter is kept rather than
 * rejected, since an export that does that is still worth reading.
 */

/** Options for {@link parseCsv}. */
export interface CsvOptions {
  /** The field delimiter. Detected from the first lines when not given. */
  delimiter?: string;
}

const CANDIDATE_DELIMITERS = [",", "\t", ";", "|"] as const;

/**
 * Guess the delimiter from the first few records: the candidate that appears
 * on the first line and the same number of times on every sampled line wins;
 * failing that, the most frequent one. Ties go in the order comma, tab,
 * semicolon, pipe. Quoted regions are skipped so a comma inside a quoted
 * address does not vote.
 */
export function detectDelimiter(text: string, sampleLines = 10): string {
  const perLine: Map<string, number>[] = [];
  let current = new Map<string, number>(CANDIDATE_DELIMITERS.map((d) => [d, 0]));
  let inQuotes = false;

  const flush = () => {
    if ([...current.values()].some((n) => n > 0)) perLine.push(current);
    current = new Map(CANDIDATE_DELIMITERS.map((d) => [d, 0]));
  };

  for (let i = 0; i < text.length && perLine.length < sampleLines; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (!inQuotes && (ch === "\n" || ch === "\r")) {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      flush();
    } else if (!inQuotes && current.has(ch)) {
      current.set(ch, current.get(ch)! + 1);
    }
  }
  flush();

  let best = ",";
  let bestScore = -1;
  for (const d of CANDIDATE_DELIMITERS) {
    const counts = perLine.map((line) => line.get(d)!);
    if (counts.length === 0 || counts[0] === 0) continue;
    const consistent = counts.every((n) => n === counts[0]);
    const score = (consistent ? 1000 : 0) + Math.min(...counts);
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

/** Drop a UTF-8 byte-order mark, which spreadsheet exports often carry. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Parse CSV text into rows of cells. Every row is returned as it was, ragged
 * or not; padding to a common width is the caller's job. A trailing line
 * break does not produce an empty final row.
 */
export function parseCsv(text: string, options: CsvOptions = {}): string[][] {
  const input = stripBom(text);
  const delimiter = options.delimiter ?? detectDelimiter(input);
  if (delimiter.length !== 1) {
    throw new RangeError(`A CSV delimiter must be a single character, got ${JSON.stringify(delimiter)}`);
  }

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let quotedCell = false;
  let i = 0;
  const length = input.length;

  const endCell = () => {
    row.push(cell);
    cell = "";
    quotedCell = false;
  };
  const endRow = () => {
    endCell();
    rows.push(row);
    row = [];
  };

  while (i < length) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          cell += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        cell += ch;
        i += 1;
      }
      continue;
    }

    if (ch === '"' && cell.length === 0 && !quotedCell) {
      inQuotes = true;
      quotedCell = true;
      i += 1;
    } else if (ch === delimiter) {
      endCell();
      i += 1;
    } else if (ch === "\n" || ch === "\r") {
      endRow();
      i += ch === "\r" && input[i + 1] === "\n" ? 2 : 1;
    } else {
      cell += ch;
      i += 1;
    }
  }

  // The last record: flushed unless the input ended on a line break and the
  // pending row is the empty one that break left behind.
  if (cell.length > 0 || quotedCell || row.length > 0) endRow();

  return rows;
}
