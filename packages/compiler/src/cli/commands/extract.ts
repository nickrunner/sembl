import { resolve } from "node:path";
import { glob } from "glob";
import { extractSchemas } from "../../extractor/ast-extractor.js";
import { emitSchemas } from "../../generator/schema-emitter.js";

export interface ExtractCommandOptions {
  input: string;
  output: string;
  tsconfig?: string;
}

export async function extractCommand(options: ExtractCommandOptions): Promise<void> {
  const inputDir = resolve(options.input);
  const outputDir = resolve(options.output);

  // Find all .ts files in the input directory
  const files = await glob("**/*.ts", {
    cwd: inputDir,
    absolute: true,
    ignore: ["**/*.d.ts", "**/*.schema.ts", "**/node_modules/**"],
  });

  if (files.length === 0) {
    console.log(`No TypeScript files found in ${inputDir}`);
    return;
  }

  console.log(`Found ${files.length} source file(s) in ${inputDir}`);

  const bundle = extractSchemas({
    filePatterns: files,
    tsconfigPath: options.tsconfig,
  });

  const schemaCount = Object.keys(bundle.schemas).length;
  if (schemaCount === 0) {
    console.log("No @Schema-decorated classes found.");
    return;
  }

  const emitted = emitSchemas(bundle, outputDir);
  console.log(
    `Extracted ${schemaCount} schema(s), emitted ${emitted.length} file(s) to ${outputDir}`,
  );
}
