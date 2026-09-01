import { resolve } from "node:path";
import { glob } from "glob";
import { extractSchemas } from "../../extractor/ast-extractor.js";
import { emitSchemas } from "../../generator/schema-emitter.js";

export interface ExtractCommandOptions {
  input: string;
  output: string;
  tsconfig?: string;
  /** Treat extraction warnings as errors. For CI and pre-build hooks. */
  strict?: boolean;
}

/**
 * What the command did. Returned rather than exited on, so the process owns
 * its exit code in one place and tests can assert without spawning.
 */
export interface ExtractCommandResult {
  /** Number of schemas emitted, including any synthesized for inline types. */
  schemaCount: number;
  /** Absolute paths of the files written. */
  emittedFiles: string[];
  /** Warnings raised during extraction, in discovery order. */
  warnings: string[];
  /** 0 on success; 1 on a misconfiguration, or on any warning under --strict. */
  exitCode: number;
}

export async function extractCommand(
  options: ExtractCommandOptions,
): Promise<ExtractCommandResult> {
  const inputDir = resolve(options.input);
  const outputDir = resolve(options.output);

  // Find all .ts files in the input directory
  const files = await glob("**/*.ts", {
    cwd: inputDir,
    absolute: true,
    ignore: ["**/*.d.ts", "**/*.schema.ts", "**/node_modules/**"],
  });

  if (files.length === 0) {
    // Extract runs ahead of the build, and the build imports the bundle this
    // step writes. Succeeding quietly here just moves the failure to a later,
    // less legible "cannot find ./generated/index.js".
    console.error(`sembl extract: no TypeScript files found in ${inputDir}`);
    return { schemaCount: 0, emittedFiles: [], warnings: [], exitCode: 1 };
  }

  console.log(`Found ${files.length} source file(s) in ${inputDir}`);

  const result = extractSchemas({
    filePatterns: files,
    tsconfigPath: options.tsconfig,
  });

  // Warnings go to stderr so they survive a pipeline that captures stdout, and
  // are printed before the summary so the last line is the outcome.
  for (const warning of result.warnings) {
    console.error(`sembl extract: warning: ${warning}`);
  }

  const schemaCount = Object.keys(result.schemas).length;
  if (schemaCount === 0) {
    console.error(
      `sembl extract: no @Schema-decorated classes found in ${inputDir}`,
    );
    return {
      schemaCount: 0,
      emittedFiles: [],
      warnings: result.warnings,
      exitCode: 1,
    };
  }

  const emitted = emitSchemas(result, outputDir);
  console.log(
    `Extracted ${schemaCount} schema(s), emitted ${emitted.length} file(s) to ${outputDir}`,
  );

  const failOnWarnings = options.strict === true && result.warnings.length > 0;
  if (result.warnings.length > 0) {
    console.error(
      `sembl extract: ${result.warnings.length} warning(s).` +
        (failOnWarnings ? " Failing because --strict is set." : ""),
    );
  }

  return {
    schemaCount,
    emittedFiles: emitted,
    warnings: result.warnings,
    exitCode: failOnWarnings ? 1 : 0,
  };
}
