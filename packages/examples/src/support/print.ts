/** Small console helpers so every example reads the same way. */

export function heading(title: string): void {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
  console.log("─".repeat(Math.min(72, title.length + 8)));
}

export function note(text: string): void {
  console.log(`\x1b[2m${text}\x1b[0m`);
}

export function show(label: string, value: unknown): void {
  const rendered = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  console.log(`${label}:`);
  console.log(rendered.split("\n").map((l) => `  ${l}`).join("\n"));
}

export function ok(text: string): void {
  console.log(`\x1b[32m✓\x1b[0m ${text}`);
}

export function warn(text: string): void {
  console.log(`\x1b[33m!\x1b[0m ${text}`);
}

/** Left-aligned columns without a dependency. */
export function table(rows: Record<string, unknown>[]): void {
  if (rows.length === 0) return;
  const keys = Object.keys(rows[0]);
  const cell = (v: unknown) => (v === undefined || v === null ? "" : String(v));
  const widths = keys.map((k) => Math.max(k.length, ...rows.map((r) => cell(r[k]).length)));
  const line = (vals: string[]) => "  " + vals.map((v, i) => v.padEnd(widths[i])).join("  ");
  console.log(line(keys));
  console.log(line(widths.map((w) => "─".repeat(w))));
  for (const row of rows) console.log(line(keys.map((k) => cell(row[k]))));
}
