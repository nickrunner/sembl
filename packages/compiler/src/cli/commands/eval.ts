import { pathToFileURL } from "node:url";
import { resolve, join } from "node:path";
import type { Provider, RuntimeSchema, SchemaBundle, EnumResolver, CoerceOptions } from "@sembl/core";
import {
  runEval,
  loadFixtures,
  loadReport,
  saveReport,
  diffReports,
  formatReport,
  replayOrRecord,
} from "@sembl/testing";
import type { TokenPrices, EvalReport, EvalDiff } from "@sembl/testing";

export interface EvalCommandOptions {
  /** A JS module exporting the schema and provider to evaluate with. */
  config: string;
  /** Directory of fixture JSON files. */
  fixtures: string;
  /** Where to write the report; defaults to `<fixtures>/.sembl-eval/last-run.json`. */
  out?: string;
  mode?: "coerce" | "partialCoerce";
  provenance?: boolean;
  concurrency?: number;
  /** Replay recordings from this directory, recording misses through the provider. */
  replay?: string;
  /** Exit non-zero when overall recall lands below this fraction. */
  minRecall?: number;
  /** Exit non-zero when overall precision lands below this fraction. */
  minPrecision?: number;
}

/**
 * What an eval config module exports. Written as a plain JS module so the
 * CLI can `import()` it without a TypeScript loader; a TS project can point
 * at its build output, or keep the config in `.mjs`.
 */
export interface EvalConfig {
  schema: RuntimeSchema;
  provider: Provider;
  bundle?: SchemaBundle;
  enumResolver?: EnumResolver;
  prices?: TokenPrices;
  /** Any other coercion options: `onInvalidField`, `maxRepairAttempts`, `maxInputChars`, … */
  coerceOptions?: Partial<Omit<CoerceOptions, "schema" | "provider" | "bundle" | "enumResolver">>;
}

export interface EvalCommandResult {
  report?: EvalReport;
  diff?: EvalDiff;
  exitCode: number;
}

async function loadConfig(path: string): Promise<EvalConfig> {
  const url = pathToFileURL(resolve(path)).href;
  const mod = (await import(url)) as { default?: Partial<EvalConfig> } & Partial<EvalConfig>;
  const config: Partial<EvalConfig> = mod.default ?? mod;
  if (!config.schema || typeof config.schema !== "object" || !("id" in config.schema)) {
    throw new Error(`${path} must export a \`schema\` (a RuntimeSchema or defineSchema result)`);
  }
  if (!config.provider || typeof config.provider.complete !== "function") {
    throw new Error(`${path} must export a \`provider\``);
  }
  return config as EvalConfig;
}

export async function evalCommand(options: EvalCommandOptions): Promise<EvalCommandResult> {
  let config: EvalConfig;
  let fixtures;
  try {
    config = await loadConfig(options.config);
    fixtures = loadFixtures(options.fixtures);
  } catch (error) {
    console.error(`sembl eval: ${error instanceof Error ? error.message : String(error)}`);
    return { exitCode: 1 };
  }
  if (fixtures.length === 0) {
    console.error(`sembl eval: no fixtures found in ${resolve(options.fixtures)}`);
    return { exitCode: 1 };
  }

  const provider = options.replay ? replayOrRecord(resolve(options.replay), config.provider) : config.provider;
  const out = options.out ?? join(resolve(options.fixtures), ".sembl-eval", "last-run.json");
  const previous = loadReport(out);

  const report = await runEval({
    ...config.coerceOptions,
    schema: config.schema,
    bundle: config.bundle,
    enumResolver: config.enumResolver,
    prices: config.prices,
    provider,
    fixtures,
    mode: options.mode,
    provenance: options.provenance,
    concurrency: options.concurrency,
  });
  const diff = previous ? diffReports(previous, report) : undefined;

  console.log(formatReport(report, diff));
  saveReport(report, out);
  console.log(`\nReport written to ${out}${previous ? " (deltas are against the previous run)" : ""}`);

  const below = (value: number | null, floor: number | undefined) =>
    floor !== undefined && (value === null || value < floor);
  let exitCode = 0;
  if (below(report.totals.recall, options.minRecall)) {
    console.error(`sembl eval: recall ${fmt(report.totals.recall)} is below --min-recall ${options.minRecall}`);
    exitCode = 1;
  }
  if (below(report.totals.precision, options.minPrecision)) {
    console.error(`sembl eval: precision ${fmt(report.totals.precision)} is below --min-precision ${options.minPrecision}`);
    exitCode = 1;
  }
  return { report, diff, exitCode };
}

function fmt(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(2);
}
