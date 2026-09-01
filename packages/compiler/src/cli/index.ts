import { Command } from "commander";
import { extractCommand } from "./commands/extract.js";

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

program.parse();
