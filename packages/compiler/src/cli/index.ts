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
  .action(async (options) => {
    await extractCommand({
      input: options.input,
      output: options.output,
      tsconfig: options.tsconfig,
    });
  });

program.parse();
