import { Command } from "commander";
import { extractCommand } from "./commands/extract.js";
import { evalCommand } from "./commands/eval.js";

const program = new Command();

program
  .name("sembl")
  .description("SEMBL schema compiler — extract runtime schemas from decorated TypeScript classes")
  .version("0.1.0");

program
  .command("extract")
  .description("Extract @Schema-decorated classes into RuntimeSchema files")
  .requiredOption("-i, --input <path>", "Input directory containing decorated schema classes")
  .requiredOption("-o, --output <path>", "Output directory for generated .schema.ts files")
  .option("--tsconfig <path>", "Path to tsconfig.json")
  .option("--strict", "Exit non-zero if extraction produced any warnings")
  .action(async (options) => {
    const result = await extractCommand({
      input: options.input,
      output: options.output,
      tsconfig: options.tsconfig,
      strict: options.strict,
    });
    // Set the code rather than exiting, so buffered stdout/stderr still flush.
    process.exitCode = result.exitCode;
  });

program
  .command("eval")
  .description("Run fixtures through a schema and report per-field precision and recall")
  .requiredOption("-c, --config <path>", "JS module exporting { schema, provider, … }")
  .requiredOption("-f, --fixtures <dir>", "Directory of fixture JSON files")
  .option("-o, --out <file>", "Where to write the report (default: <fixtures>/.sembl-eval/last-run.json)")
  .option("--mode <mode>", "coerce or partialCoerce", "coerce")
  .option("--provenance", "Ask for provenance and show confidence on mismatches")
  .option("--concurrency <n>", "Fixtures to run at once", "1")
  .option("--replay <dir>", "Replay recordings from this directory; record misses through the provider")
  .option("--min-recall <fraction>", "Fail when overall recall is below this")
  .option("--min-precision <fraction>", "Fail when overall precision is below this")
  .action(async (options) => {
    const mode = options.mode === "partialCoerce" ? "partialCoerce" : "coerce";
    const result = await evalCommand({
      config: options.config,
      fixtures: options.fixtures,
      out: options.out,
      mode,
      provenance: options.provenance,
      concurrency: Number(options.concurrency),
      replay: options.replay,
      minRecall: options.minRecall !== undefined ? Number(options.minRecall) : undefined,
      minPrecision: options.minPrecision !== undefined ? Number(options.minPrecision) : undefined,
    });
    process.exitCode = result.exitCode;
  });

program.parse();
