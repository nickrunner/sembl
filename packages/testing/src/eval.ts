import { AsyncLocalStorage } from "node:async_hooks";
import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  coerce,
  partialCoerce,
  coerceWithProvenance,
  partialCoerceWithProvenance,
} from "@sembl/core";
import type {
  CoerceInput,
  CoerceOptions,
  FieldProvenance,
  Provider,
  ProviderRequest,
  ProviderResponse,
  ProviderUsage,
  ResolvedIssue,
  Source,
} from "@sembl/core";

/** One case: an input and what a correct extraction of it looks like. */
export interface EvalFixture {
  /** Shown in the report. Defaults to the file it was loaded from. */
  name?: string;
  input: CoerceInput;
  /** The expected extraction. Absent and `null` both mean "not present". */
  expected: Record<string, unknown>;
}

/** Per-million-token prices, for a cost line in the report. */
export interface TokenPrices {
  inputPerMTok: number;
  outputPerMTok: number;
  /** Defaults to `inputPerMTok` when the provider reports cache reads. */
  cacheReadPerMTok?: number;
  /** Defaults to `inputPerMTok` when the provider reports cache writes. */
  cacheWritePerMTok?: number;
}

/** Options for {@link runEval}. Everything in `CoerceOptions` applies per fixture. */
export interface EvalOptions extends CoerceOptions {
  fixtures: readonly EvalFixture[];
  /** Which coercion to run. Default `"coerce"`. */
  mode?: "coerce" | "partialCoerce";
  /** Ask for provenance, so the report can show confidence per field. */
  provenance?: boolean;
  /** How many fixtures run at once. Default 1, for stable latency numbers. */
  concurrency?: number;
  /** Prices for the cost line. Without them the report has no cost. */
  prices?: TokenPrices;
}

/** How one leaf compared. */
export type LeafOutcome = "match" | "wrong" | "missing" | "extra";

export interface LeafResult {
  path: string;
  outcome: LeafOutcome;
  expected?: unknown;
  actual?: unknown;
  confidence?: FieldProvenance["confidence"];
}

export interface EvalItem {
  name: string;
  ok: boolean;
  /** Message of the error the coercion threw, when it did. */
  error?: string;
  /** Whether every expected leaf matched and nothing extra came back. */
  exact: boolean;
  leaves: LeafResult[];
  issues: ResolvedIssue[];
  latencyMs: number;
  calls: number;
  usage: Usage;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface FieldStats {
  path: string;
  tp: number;
  fp: number;
  fn: number;
  /** `tp / (tp + fp)`; null when nothing was returned for the field. */
  precision: number | null;
  /** `tp / (tp + fn)`; null when nothing was expected for the field. */
  recall: number | null;
}

export interface EvalTotals {
  fixtures: number;
  ok: number;
  exact: number;
  precision: number | null;
  recall: number | null;
  usage: Usage;
  calls: number;
  cost?: number;
  latencyMs: { p50: number; p95: number; max: number; total: number };
}

export interface EvalReport {
  schemaId: string;
  mode: "coerce" | "partialCoerce";
  ranAt: string;
  items: EvalItem[];
  fields: FieldStats[];
  totals: EvalTotals;
}

// ---------------------------------------------------------------------------
// Fixtures

interface FileInput {
  file: string;
  label?: string;
}

function isFileInput(value: unknown): value is FileInput {
  return typeof value === "object" && value !== null && typeof (value as FileInput).file === "string";
}

/** Resolve `{ file, label }` inputs against the fixture's own directory. */
function resolveInput(input: unknown, baseDir: string): CoerceInput {
  const one = (value: unknown): Source | string => {
    if (typeof value === "string") return value;
    if (isFileInput(value)) {
      const text = readFileSync(resolve(baseDir, value.file), "utf8");
      return value.label ? { label: value.label, text } : { text };
    }
    return value as Source;
  };
  if (Array.isArray(input)) {
    return input.map((v) => {
      const r = one(v);
      return typeof r === "string" ? { text: r } : r;
    });
  }
  return one(input);
}

/**
 * Load fixtures from a directory: every `*.json` file is either one fixture
 * or an array of them. An input may be `{ "file": "page.html", "label": … }`
 * to pull text from a sibling file, which keeps large scraped pages out of
 * the JSON.
 */
export function loadFixtures(dir: string): EvalFixture[] {
  const root = resolve(dir);
  if (!existsSync(root)) {
    throw new Error(`Fixture directory not found: ${root}`);
  }
  const fixtures: EvalFixture[] = [];
  const files = readdirSync(root)
    .filter((f) => f.endsWith(".json") && !f.startsWith("."))
    .sort();
  for (const file of files) {
    const path = join(root, file);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const list = Array.isArray(parsed) ? parsed : [parsed];
    list.forEach((raw, index) => {
      const fixture = raw as EvalFixture;
      if (!fixture || typeof fixture !== "object" || !("input" in fixture) || !("expected" in fixture)) {
        throw new Error(`${path}${list.length > 1 ? `[${index}]` : ""}: a fixture needs "input" and "expected"`);
      }
      const stem = basename(file, ".json");
      fixtures.push({
        name: fixture.name ?? (list.length > 1 ? `${stem}[${index}]` : stem),
        input: resolveInput(fixture.input, dirname(path)),
        expected: fixture.expected,
      });
    });
  }
  return fixtures;
}

// ---------------------------------------------------------------------------
// Scoring

function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

function isPrimitive(value: unknown): boolean {
  return value === null || typeof value !== "object";
}

/**
 * Flatten a value to its leaves, keyed by dotted path. Objects recurse;
 * arrays are leaves. `null` and `undefined` are absence, not leaves.
 */
export function flattenLeaves(value: unknown, prefix = ""): Map<string, unknown> {
  const leaves = new Map<string, unknown>();
  if (value === null || value === undefined) return leaves;
  if (typeof value !== "object" || Array.isArray(value)) {
    leaves.set(prefix, value);
    return leaves;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    for (const [leafPath, leaf] of flattenLeaves(child, path)) {
      leaves.set(leafPath, leaf);
    }
  }
  return leaves;
}

/**
 * Whether two leaves agree. Arrays of primitives compare as multisets —
 * the order amenities come back in is not a fact about the listing —
 * and everything else compares structurally.
 */
export function leavesEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    if (a.every(isPrimitive) && b.every(isPrimitive)) {
      const sortedA = [...a].map(String).sort();
      const sortedB = [...b].map(String).sort();
      return sortedA.every((v, i) => v === sortedB[i]);
    }
  }
  return stable(a) === stable(b);
}

/** Compare one extraction against its expectation, leaf by leaf. */
export function compareLeaves(
  expected: Record<string, unknown>,
  actual: Record<string, unknown> | undefined,
  provenance: Record<string, FieldProvenance> = {},
): LeafResult[] {
  const want = flattenLeaves(expected);
  const got = flattenLeaves(actual ?? {});
  const paths = [...new Set([...want.keys(), ...got.keys()])].sort();
  return paths.map((path) => {
    const top = path.split(".")[0];
    const confidence = provenance[top]?.confidence;
    const result: LeafResult = { path, outcome: "match" };
    if (confidence) result.confidence = confidence;
    if (want.has(path) && got.has(path)) {
      result.expected = want.get(path);
      result.actual = got.get(path);
      result.outcome = leavesEqual(want.get(path), got.get(path)) ? "match" : "wrong";
    } else if (want.has(path)) {
      result.expected = want.get(path);
      result.outcome = "missing";
    } else {
      result.actual = got.get(path);
      result.outcome = "extra";
    }
    return result;
  });
}

function ratio(num: number, den: number): number | null {
  return den === 0 ? null : num / den;
}

/** Aggregate leaf outcomes into per-field precision and recall. */
export function fieldStats(items: readonly EvalItem[]): FieldStats[] {
  const byPath = new Map<string, { tp: number; fp: number; fn: number }>();
  for (const item of items) {
    for (const leaf of item.leaves) {
      const stats = byPath.get(leaf.path) ?? { tp: 0, fp: 0, fn: 0 };
      switch (leaf.outcome) {
        case "match":
          stats.tp += 1;
          break;
        case "wrong":
          stats.fp += 1;
          stats.fn += 1;
          break;
        case "missing":
          stats.fn += 1;
          break;
        case "extra":
          stats.fp += 1;
          break;
      }
      byPath.set(leaf.path, stats);
    }
  }
  return [...byPath.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, { tp, fp, fn }]) => ({
      path,
      tp,
      fp,
      fn,
      precision: ratio(tp, tp + fp),
      recall: ratio(tp, tp + fn),
    }));
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function emptyUsage(): Usage {
  return { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

function addUsage(into: Usage, usage: ProviderUsage | undefined): void {
  if (!usage) return;
  into.promptTokens += usage.promptTokens;
  into.completionTokens += usage.completionTokens;
  into.cacheReadTokens += usage.cacheReadTokens ?? 0;
  into.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
}

/** Dollars, from per-million-token prices. */
export function estimateCost(usage: Usage, prices: TokenPrices): number {
  const per = (tokens: number, price: number) => (tokens / 1_000_000) * price;
  return (
    per(usage.promptTokens, prices.inputPerMTok) +
    per(usage.completionTokens, prices.outputPerMTok) +
    per(usage.cacheReadTokens, prices.cacheReadPerMTok ?? prices.inputPerMTok) +
    per(usage.cacheWriteTokens, prices.cacheWritePerMTok ?? prices.inputPerMTok)
  );
}

// ---------------------------------------------------------------------------
// Running

interface ItemContext {
  usage: Usage;
  calls: number;
}

const context = new AsyncLocalStorage<ItemContext>();

/** Credits each call's usage to whichever fixture is running it. */
class MeteredProvider implements Provider {
  constructor(private readonly inner: Provider) {}

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const response = await this.inner.complete(request);
    const ctx = context.getStore();
    if (ctx) {
      ctx.calls += 1;
      addUsage(ctx.usage, response.usage);
    }
    return response;
  }
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Run every fixture through a coercion and score the results.
 *
 * Per-field precision and recall make a description change measurable: a
 * field whose recall dropped after a rewording is a field the rewording
 * hurt. Token usage and latency come along so the cost of a change is
 * visible next to its effect. Pair it with a `ReplayProvider` to run in CI
 * without spend.
 */
export async function runEval(options: EvalOptions): Promise<EvalReport> {
  const {
    fixtures,
    mode = "coerce",
    provenance = false,
    concurrency = 1,
    prices,
    provider,
    ...coerceOptions
  } = options;
  const metered = new MeteredProvider(provider);
  const run = mode === "coerce"
    ? provenance ? coerceWithProvenance : coerce
    : provenance ? partialCoerceWithProvenance : partialCoerce;

  const items = await mapWithConcurrency(fixtures, concurrency, async (fixture, index) => {
    const ctx: ItemContext = { usage: emptyUsage(), calls: 0 };
    const name = fixture.name ?? `fixture ${index + 1}`;
    const started = performance.now();
    return context.run(ctx, async (): Promise<EvalItem> => {
      try {
        const result = await run<Record<string, unknown>>(fixture.input, {
          ...coerceOptions,
          provider: metered,
        });
        const data = provenance
          ? (result as { data: Record<string, unknown> }).data
          : (result as Record<string, unknown>);
        const prov = provenance ? (result as { provenance: Record<string, FieldProvenance> }).provenance : {};
        const issues = provenance ? (result as { issues: ResolvedIssue[] }).issues : [];
        const leaves = compareLeaves(fixture.expected, data, prov);
        return {
          name,
          ok: true,
          exact: leaves.every((l) => l.outcome === "match"),
          leaves,
          issues,
          latencyMs: Math.round(performance.now() - started),
          calls: ctx.calls,
          usage: ctx.usage,
        };
      } catch (error) {
        return {
          name,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          exact: false,
          leaves: compareLeaves(fixture.expected, undefined),
          issues: [],
          latencyMs: Math.round(performance.now() - started),
          calls: ctx.calls,
          usage: ctx.usage,
        };
      }
    });
  });

  const fields = fieldStats(items);
  const tp = fields.reduce((s, f) => s + f.tp, 0);
  const fp = fields.reduce((s, f) => s + f.fp, 0);
  const fn = fields.reduce((s, f) => s + f.fn, 0);
  const usage = emptyUsage();
  for (const item of items) {
    usage.promptTokens += item.usage.promptTokens;
    usage.completionTokens += item.usage.completionTokens;
    usage.cacheReadTokens += item.usage.cacheReadTokens;
    usage.cacheWriteTokens += item.usage.cacheWriteTokens;
  }
  const latencies = items.map((i) => i.latencyMs).sort((a, b) => a - b);

  return {
    schemaId: options.schema.id,
    mode,
    ranAt: new Date().toISOString(),
    items,
    fields,
    totals: {
      fixtures: items.length,
      ok: items.filter((i) => i.ok).length,
      exact: items.filter((i) => i.exact).length,
      precision: ratio(tp, tp + fp),
      recall: ratio(tp, tp + fn),
      usage,
      calls: items.reduce((s, i) => s + i.calls, 0),
      ...(prices ? { cost: estimateCost(usage, prices) } : {}),
      latencyMs: {
        p50: percentile(latencies, 50),
        p95: percentile(latencies, 95),
        max: latencies[latencies.length - 1] ?? 0,
        total: latencies.reduce((s, l) => s + l, 0),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Persistence and diffs

export function saveReport(report: EvalReport, file: string): void {
  mkdirSync(dirname(resolve(file)), { recursive: true });
  writeFileSync(resolve(file), JSON.stringify(report, null, 2) + "\n");
}

export function loadReport(file: string): EvalReport | undefined {
  const path = resolve(file);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as EvalReport;
}

export interface FieldDelta {
  path: string;
  precision: number | null;
  recall: number | null;
}

/** What changed between two runs. Deltas are `next − previous`. */
export interface EvalDiff {
  exact: number;
  ok: number;
  precision: number | null;
  recall: number | null;
  promptTokens: number;
  completionTokens: number;
  cost?: number;
  p50Ms: number;
  /** Fields whose precision or recall moved, largest drop first. */
  fields: FieldDelta[];
}

function delta(a: number | null | undefined, b: number | null | undefined): number | null {
  return a === null || a === undefined || b === null || b === undefined ? null : b - a;
}

export function diffReports(previous: EvalReport, next: EvalReport): EvalDiff {
  const prevFields = new Map(previous.fields.map((f) => [f.path, f]));
  const fields: FieldDelta[] = [];
  for (const field of next.fields) {
    const before = prevFields.get(field.path);
    const precision = delta(before?.precision, field.precision);
    const recall = delta(before?.recall, field.recall);
    if ((precision !== null && precision !== 0) || (recall !== null && recall !== 0)) {
      fields.push({ path: field.path, precision, recall });
    }
  }
  fields.sort((a, b) => Math.min(a.precision ?? 0, a.recall ?? 0) - Math.min(b.precision ?? 0, b.recall ?? 0));

  return {
    exact: next.totals.exact - previous.totals.exact,
    ok: next.totals.ok - previous.totals.ok,
    precision: delta(previous.totals.precision, next.totals.precision),
    recall: delta(previous.totals.recall, next.totals.recall),
    promptTokens: next.totals.usage.promptTokens - previous.totals.usage.promptTokens,
    completionTokens: next.totals.usage.completionTokens - previous.totals.usage.completionTokens,
    ...(next.totals.cost !== undefined && previous.totals.cost !== undefined
      ? { cost: next.totals.cost - previous.totals.cost }
      : {}),
    p50Ms: next.totals.latencyMs.p50 - previous.totals.latencyMs.p50,
    fields,
  };
}

// ---------------------------------------------------------------------------
// Formatting

function pct(value: number | null): string {
  return value === null ? "  –  " : `${(value * 100).toFixed(0).padStart(3)}%`;
}

function signed(value: number | null, digits = 0, suffix = ""): string {
  if (value === null || value === 0) return "";
  const text = digits > 0 ? value.toFixed(digits) : String(value);
  return ` (${value > 0 ? "+" : ""}${text}${suffix})`;
}

function signedPct(value: number | null): string {
  return value === null || value === 0 ? "" : ` (${value > 0 ? "+" : ""}${(value * 100).toFixed(0)}pt)`;
}

/** A plain-text report for a terminal, with deltas when a previous run is given. */
export function formatReport(report: EvalReport, diff?: EvalDiff): string {
  const t = report.totals;
  const lines: string[] = [];
  lines.push(
    `Eval: ${report.schemaId} (${report.mode}) — ${t.fixtures} fixture(s), ${t.ok} ran${signed(diff?.ok ?? null)}, ${t.exact} exact${signed(diff?.exact ?? null)}`,
  );
  lines.push("");

  const width = Math.max(5, ...report.fields.map((f) => f.path.length));
  const deltas = new Map((diff?.fields ?? []).map((f) => [f.path, f]));
  lines.push(`${"Field".padEnd(width)}  Prec  Recall   tp  fp  fn  Δ`);
  const col = (value: number | null, w: number) => pct(value).trim().padStart(w);
  for (const field of report.fields) {
    const d = deltas.get(field.path);
    const change = d
      ? [d.precision !== null && d.precision !== 0 ? `P${signedPct(d.precision).trim()}` : "", d.recall !== null && d.recall !== 0 ? `R${signedPct(d.recall).trim()}` : ""]
          .filter(Boolean)
          .join(" ")
      : "";
    lines.push(
      `${field.path.padEnd(width)}  ${col(field.precision, 4)}  ${col(field.recall, 6)}   ${String(field.tp).padStart(2)}  ${String(field.fp).padStart(2)}  ${String(field.fn).padStart(2)}  ${change}`,
    );
  }
  lines.push("");
  lines.push(
    `Overall: precision ${pct(t.precision).trim()}${signedPct(diff?.precision ?? null)}, recall ${pct(t.recall).trim()}${signedPct(diff?.recall ?? null)}`,
  );
  const u = t.usage;
  const cache = u.cacheReadTokens || u.cacheWriteTokens
    ? `, cache read ${u.cacheReadTokens.toLocaleString("en-US")} / write ${u.cacheWriteTokens.toLocaleString("en-US")}`
    : "";
  lines.push(
    `Tokens: ${u.promptTokens.toLocaleString("en-US")} prompt${signed(diff?.promptTokens ?? null)} / ${u.completionTokens.toLocaleString("en-US")} completion${signed(diff?.completionTokens ?? null)}${cache}; ${t.calls} call(s)` +
      (t.cost !== undefined ? `; cost $${t.cost.toFixed(4)}${signed(diff?.cost ?? null, 4)}` : ""),
  );
  lines.push(
    `Latency: p50 ${t.latencyMs.p50}ms${signed(diff?.p50Ms ?? null, 0, "ms")}, p95 ${t.latencyMs.p95}ms, max ${t.latencyMs.max}ms`,
  );

  const failed = report.items.filter((i) => !i.ok);
  if (failed.length > 0) {
    lines.push("");
    lines.push("Failed:");
    for (const item of failed) lines.push(`  ${item.name}: ${item.error}`);
  }
  const imperfect = report.items.filter((i) => i.ok && !i.exact);
  if (imperfect.length > 0) {
    lines.push("");
    lines.push("Mismatches:");
    for (const item of imperfect) {
      for (const leaf of item.leaves.filter((l) => l.outcome !== "match")) {
        const detail =
          leaf.outcome === "wrong"
            ? `expected ${JSON.stringify(leaf.expected)}, got ${JSON.stringify(leaf.actual)}`
            : leaf.outcome === "missing"
              ? `expected ${JSON.stringify(leaf.expected)}, got nothing`
              : `unexpected ${JSON.stringify(leaf.actual)}`;
        const conf = leaf.confidence ? ` [${leaf.confidence}]` : "";
        lines.push(`  ${item.name} › ${leaf.path}: ${detail}${conf}`);
      }
    }
  }
  return lines.join("\n");
}
