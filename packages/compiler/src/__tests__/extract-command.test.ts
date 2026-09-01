import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, copyFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { extractCommand } from "../cli/commands/extract.js";

const fixturesDir = resolve(import.meta.dirname, "fixtures");

describe("extractCommand", () => {
  let outputDir: string;
  let inputDir: string;
  let errors: string[];

  beforeEach(() => {
    outputDir = mkdtempSync(join(tmpdir(), "sembl-out-"));
    inputDir = mkdtempSync(join(tmpdir(), "sembl-in-"));
    errors = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.join(" "));
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(outputDir, { recursive: true, force: true });
    rmSync(inputDir, { recursive: true, force: true });
  });

  /** Stage a fixture as the sole input file for one run. */
  function useFixture(name: string): void {
    copyFileSync(join(fixturesDir, name), join(inputDir, name));
  }

  it("succeeds quietly on input that produces no warnings", async () => {
    useFixture("basic-schemas.ts");

    const result = await extractCommand({ input: inputDir, output: outputDir });

    expect(result.warnings).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(result.schemaCount).toBe(2);
    expect(errors).toEqual([]);
  });

  it("prints every extraction warning to stderr", async () => {
    useFixture("unsupported-types.ts");

    const result = await extractCommand({ input: inputDir, output: outputDir });

    expect(result.warnings.length).toBeGreaterThan(0);
    for (const warning of result.warnings) {
      expect(errors).toContain(`sembl extract: warning: ${warning}`);
    }
    expect(errors.at(-1)).toContain(`${result.warnings.length} warning(s)`);
  });

  it("still emits, and still exits 0, when warnings are only advisory", async () => {
    useFixture("unsupported-types.ts");

    const result = await extractCommand({ input: inputDir, output: outputDir });

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(outputDir, "index.ts"))).toBe(true);
  });

  it("exits 1 on any warning under --strict", async () => {
    useFixture("unsupported-types.ts");

    const result = await extractCommand({
      input: inputDir,
      output: outputDir,
      strict: true,
    });

    expect(result.exitCode).toBe(1);
    expect(errors.at(-1)).toContain("--strict");
  });

  it("exits 0 under --strict when there is nothing to warn about", async () => {
    useFixture("basic-schemas.ts");

    const result = await extractCommand({
      input: inputDir,
      output: outputDir,
      strict: true,
    });

    expect(result.exitCode).toBe(0);
  });

  it("exits 1 when the input directory holds no TypeScript files", async () => {
    // The build step that follows imports the bundle this command writes, so
    // an empty success here only defers the failure to a worse error message.
    const result = await extractCommand({ input: inputDir, output: outputDir });

    expect(result.exitCode).toBe(1);
    expect(errors.at(-1)).toContain("no TypeScript files found");
  });

  it("exits 1 when no class is decorated with @Schema", async () => {
    useFixture("no-schemas.ts");

    const result = await extractCommand({ input: inputDir, output: outputDir });

    expect(result.exitCode).toBe(1);
    expect(result.schemaCount).toBe(0);
    expect(errors.at(-1)).toContain("no @Schema-decorated classes found");
  });

  it("emits schemas synthesized for inline object types as their own files", async () => {
    useFixture("inline-object-schemas.ts");

    const result = await extractCommand({ input: inputDir, output: outputDir });

    expect(result.exitCode).toBe(0);
    // Two declared classes plus one file per synthesized inline type, plus the
    // bundle index.
    expect(result.schemaCount).toBeGreaterThan(2);
    expect(result.emittedFiles).toHaveLength(result.schemaCount + 1);
    for (const file of result.emittedFiles) {
      expect(existsSync(file)).toBe(true);
    }
  });
});
