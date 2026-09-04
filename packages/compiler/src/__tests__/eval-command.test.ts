import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { evalCommand } from "../cli/commands/eval.js";

const evalDir = resolve(import.meta.dirname, "fixtures", "eval");

describe("evalCommand", () => {
  let dir: string;
  let logs: string[];
  let errors: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sembl-eval-cmd-"));
    logs = [];
    errors = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.join(" "));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs the fixtures, prints a report, and writes it", async () => {
    const out = join(dir, "run.json");
    const result = await evalCommand({
      config: join(evalDir, "eval.config.mjs"),
      fixtures: join(evalDir, "cases"),
      out,
    });
    expect(result.exitCode).toBe(0);
    expect(result.report?.totals).toMatchObject({ fixtures: 3, ok: 3, exact: 2 });
    expect(result.report?.totals.cost).toBeCloseTo((30 / 1e6) * 1 + (6 / 1e6) * 2, 10);
    expect(existsSync(out)).toBe(true);
    expect(logs.join("\n")).toContain("Eval: Person (coerce)");
    expect(logs.join("\n")).toContain("linus › age: expected 55, got nothing");
  });

  it("diffs against the previous run at the same path", async () => {
    const out = join(dir, "run.json");
    const opts = { config: join(evalDir, "eval.config.mjs"), fixtures: join(evalDir, "cases"), out };
    await evalCommand(opts);
    const second = await evalCommand(opts);
    expect(second.diff).toBeDefined();
    expect(second.diff?.exact).toBe(0);
    expect(logs.join("\n")).toContain("deltas are against the previous run");
  });

  it("records through a replay directory and replays on the next run", async () => {
    const replay = join(dir, "recordings");
    const opts = {
      config: join(evalDir, "eval.config.mjs"),
      fixtures: join(evalDir, "cases"),
      out: join(dir, "run.json"),
      replay,
    };
    await evalCommand(opts);
    expect(existsSync(replay)).toBe(true);
    const again = await evalCommand(opts);
    expect(again.report?.totals.ok).toBe(3);
  });

  it("fails the run when recall is below the floor", async () => {
    const result = await evalCommand({
      config: join(evalDir, "eval.config.mjs"),
      fixtures: join(evalDir, "cases"),
      out: join(dir, "run.json"),
      minRecall: 0.99,
    });
    expect(result.exitCode).toBe(1);
    expect(errors.join("\n")).toMatch(/recall .* is below --min-recall/);
  });

  it("reports a bad config or fixture directory without throwing", async () => {
    const missingConfig = await evalCommand({
      config: join(dir, "nope.mjs"),
      fixtures: join(evalDir, "cases"),
    });
    expect(missingConfig.exitCode).toBe(1);
    const missingFixtures = await evalCommand({
      config: join(evalDir, "eval.config.mjs"),
      fixtures: join(dir, "nope"),
    });
    expect(missingFixtures.exitCode).toBe(1);
    expect(errors.some((e) => e.includes("not found"))).toBe(true);
  });
});
