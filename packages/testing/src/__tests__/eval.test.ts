import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defineSchema, field } from "@sembl/core";
import type { Provider } from "@sembl/core";
import {
  compareLeaves,
  diffReports,
  fieldStats,
  formatReport,
  leavesEqual,
  loadFixtures,
  loadReport,
  runEval,
  saveReport,
} from "../eval.js";
import type { EvalItem } from "../eval.js";

const Address = defineSchema("Address", "Where it is.", {
  city: field.string("City."),
});
const Listing = defineSchema("Listing", "A rental listing.", {
  name: field.string("Name."),
  sleeps: field.number("Capacity.", { maximum: 20 }).optional(),
  amenities: field.string("Amenity.").array().optional(),
  address: field.object(Address, "Address.").optional(),
});

const fixturesDir = resolve(import.meta.dirname, "fixtures", "listing");

/** Answers by reading the plain text back out of the framed input. */
function scriptedProvider(answers: Record<string, Record<string, unknown>>): Provider {
  return {
    async complete(request) {
      const text = request.userInput.replace(/<\/?source[^>]*>/g, "").trim();
      const key = Object.keys(answers).find((k) => text.includes(k));
      if (!key) throw new Error(`no scripted answer for ${text.slice(0, 30)}`);
      return {
        data: answers[key],
        usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110, cacheReadTokens: 50 },
      };
    },
  };
}

describe("loadFixtures", () => {
  it("reads single and multi-fixture files, names them, and pulls file inputs", () => {
    const fixtures = loadFixtures(fixturesDir);
    expect(fixtures.map((f) => f.name)).toEqual(["cabin", "flat", "more[1]"]);
    expect(fixtures[0].input).toEqual({
      label: "Listing page",
      text: "Sea Cabin. Sleeps 6. Sauna and hot tub. Boise.\n",
    });
    expect(Array.isArray(fixtures[2].input)).toBe(true);
  });

  it("rejects a missing directory", () => {
    expect(() => loadFixtures(join(fixturesDir, "nope"))).toThrow(/not found/);
  });
});

describe("leaf comparison", () => {
  it("compares arrays of primitives without regard to order", () => {
    expect(leavesEqual(["a", "b"], ["b", "a"])).toBe(true);
    expect(leavesEqual(["a", "b"], ["a"])).toBe(false);
    expect(leavesEqual([{ x: 1 }, { x: 2 }], [{ x: 2 }, { x: 1 }])).toBe(false);
  });

  it("flattens nested objects and classifies every leaf", () => {
    const leaves = compareLeaves(
      { name: "A", sleeps: 6, address: { city: "Boise" }, gone: null },
      { name: "A", sleeps: 7, extra: true, address: { city: "Boise", zip: "1" } },
    );
    expect(Object.fromEntries(leaves.map((l) => [l.path, l.outcome]))).toEqual({
      name: "match",
      sleeps: "wrong",
      "address.city": "match",
      "address.zip": "extra",
      extra: "extra",
    });
  });

  it("counts a wrong value against both precision and recall", () => {
    const item = (outcome: "match" | "wrong" | "missing" | "extra"): EvalItem => ({
      name: "x", ok: true, exact: false, leaves: [{ path: "f", outcome }], issues: [],
      latencyMs: 0, calls: 1, usage: { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    const [stats] = fieldStats([item("match"), item("wrong"), item("missing"), item("extra")]);
    expect(stats).toEqual({ path: "f", tp: 1, fp: 2, fn: 2, precision: 1 / 3, recall: 1 / 3 });
  });
});

describe("runEval", () => {
  const provider = scriptedProvider({
    "Sea Cabin": { name: "Sea Cabin", sleeps: 6, amenities: ["hot tub", "sauna"], address: { city: "Boise" } },
    "City Flat": { name: "City Flat", sleeps: 3, amenities: ["wifi"] },
    Barn: { name: "Barn", sleeps: 10 },
  });

  it("scores every fixture and aggregates usage, cost and latency", async () => {
    const report = await runEval({
      fixtures: loadFixtures(fixturesDir),
      schema: Listing,
      provider,
      prices: { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3 },
    });
    expect(report.schemaId).toBe("Listing");
    expect(report.totals).toMatchObject({ fixtures: 3, ok: 3, exact: 1, calls: 3 });
    expect(report.totals.usage).toEqual({ promptTokens: 300, completionTokens: 30, cacheReadTokens: 150, cacheWriteTokens: 0 });
    expect(report.totals.cost).toBeCloseTo((300 / 1e6) * 3 + (30 / 1e6) * 15 + (150 / 1e6) * 0.3, 8);
    const sleeps = report.fields.find((f) => f.path === "sleeps")!;
    expect(sleeps).toMatchObject({ tp: 2, fp: 1, fn: 1 });
    const amenities = report.fields.find((f) => f.path === "amenities")!;
    expect(amenities).toMatchObject({ tp: 2, fp: 0, fn: 1 });
    expect(report.totals.latencyMs.p95).toBeGreaterThanOrEqual(report.totals.latencyMs.p50);
  });

  it("attributes usage per fixture even when running concurrently", async () => {
    const report = await runEval({
      fixtures: loadFixtures(fixturesDir),
      schema: Listing,
      provider,
      concurrency: 3,
    });
    expect(report.items.map((i) => i.usage.promptTokens)).toEqual([100, 100, 100]);
    expect(report.items.map((i) => i.calls)).toEqual([1, 1, 1]);
  });

  it("records a thrown coercion as a failed item with everything missing", async () => {
    const report = await runEval({
      fixtures: [{ name: "boom", input: "Sea Cabin", expected: { name: "Sea Cabin" } }],
      schema: Listing,
      provider: scriptedProvider({ "Sea Cabin": { name: 42 } }),
    });
    expect(report.items[0].ok).toBe(false);
    expect(report.items[0].error).toMatch(/validation failed/);
    expect(report.items[0].leaves).toEqual([{ path: "name", outcome: "missing", expected: "Sea Cabin" }]);
    expect(report.totals.recall).toBe(0);
  });

  it("carries confidence onto leaves when provenance is on", async () => {
    const report = await runEval({
      fixtures: [{ name: "c", input: "Sea Cabin", expected: { name: "Sea Cabin" } }],
      schema: Listing,
      provenance: true,
      provider: scriptedProvider({
        "Sea Cabin": { name: { value: "Sea Cabin", confidence: "medium", evidence: "Sea Cabin" } },
      }),
    });
    expect(report.items[0].leaves[0]).toMatchObject({ outcome: "match", confidence: "medium" });
  });
});

describe("reports", () => {
  it("round-trips through disk and diffs against a previous run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sembl-eval-"));
    try {
      const fixtures = loadFixtures(fixturesDir);
      const before = await runEval({
        fixtures,
        schema: Listing,
        provider: scriptedProvider({
          "Sea Cabin": { name: "Sea Cabin" },
          "City Flat": { name: "City Flat" },
          Barn: { name: "Barn" },
        }),
      });
      const file = join(dir, "last.json");
      saveReport(before, file);
      const after = await runEval({
        fixtures,
        schema: Listing,
        provider: scriptedProvider({
          "Sea Cabin": { name: "Sea Cabin", sleeps: 6, amenities: ["sauna", "hot tub"], address: { city: "Boise" } },
          "City Flat": { name: "City Flat", sleeps: 2, amenities: ["wifi"] },
          Barn: { name: "Wrong", sleeps: 10, amenities: ["pool"] },
        }),
      });
      const diff = diffReports(loadReport(file)!, after);
      expect(diff.exact).toBe(2);
      expect(diff.recall).toBeGreaterThan(0);
      const name = diff.fields.find((f) => f.path === "name")!;
      expect(name.precision).toBeLessThan(0);
      expect(diff.fields[0].path).toBe("name");

      const text = formatReport(after, diff);
      expect(text).toContain("Eval: Listing (coerce)");
      expect(text).toContain("3 fixture(s), 3 ran, 2 exact (+2)");
      expect(text).toMatch(/^name\s+67%\s+67%/m);
      expect(text).toContain("Mismatches:");
      expect(text).toContain('more[1] › name: expected "Barn", got "Wrong"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined for a report that does not exist", () => {
    expect(loadReport("/nonexistent/report.json")).toBeUndefined();
  });
});
