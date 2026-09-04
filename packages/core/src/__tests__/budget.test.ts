import { describe, it, expect } from "vitest";
import { budgetSources } from "../coerce/budget.js";

const text = (n: number, ch = "a") => ch.repeat(n);

describe("budgetSources", () => {
  it("leaves sources that fit untouched", () => {
    const sources = [{ text: text(50) }, { label: "b", text: text(40) }];
    const result = budgetSources(sources, 100);
    expect(result.sources).toEqual(sources);
    expect(result.truncated).toEqual([]);
  });

  it("cuts the tail by default and marks the omission", () => {
    const result = budgetSources([{ text: text(1000) }], 100);
    const [cut] = result.sources;
    expect(cut.text.length).toBeLessThanOrEqual(100);
    expect(cut.text.startsWith("aaaa")).toBe(true);
    expect(cut.text).toMatch(/\[… [\d,]+ characters omitted …\]$/);
    expect(result.truncated).toEqual([{ originalLength: 1000, keptLength: cut.text.length }]);
  });

  it("keeps the end under the head policy", () => {
    const source = { text: `${text(900)}${text(100, "z")}` };
    const [cut] = budgetSources([source], 100, "head").sources;
    expect(cut.text.startsWith("[…")).toBe(true);
    expect(cut.text.endsWith("zzzz")).toBe(true);
    expect(cut.text.length).toBeLessThanOrEqual(100);
  });

  it("keeps both ends under the middle policy", () => {
    const source = { text: `${text(500, "h")}${text(500)}${text(500, "t")}` };
    const [cut] = budgetSources([source], 120, "middle").sources;
    expect(cut.text.startsWith("hhhh")).toBe(true);
    expect(cut.text.endsWith("tttt")).toBe(true);
    expect(cut.text).toContain("characters omitted");
    expect(cut.text.length).toBeLessThanOrEqual(120);
  });

  it("cuts only the sources that exceed an equal share", () => {
    const result = budgetSources(
      [
        { label: "email", text: text(100) },
        { label: "page", text: text(900) },
      ],
      500,
    );
    const [email, page] = result.sources;
    expect(email.text.length).toBe(100);
    expect(page.text.length).toBeLessThanOrEqual(400);
    expect(result.truncated.map((t) => t.label)).toEqual(["page"]);
  });

  it("splits the budget evenly when every source is over it", () => {
    const result = budgetSources([{ text: text(900) }, { text: text(800) }], 400);
    expect(result.sources[0].text.length).toBeLessThanOrEqual(200);
    expect(result.sources[1].text.length).toBeLessThanOrEqual(200);
    expect(result.truncated).toHaveLength(2);
  });

  it("does not touch a short source next to a long one", () => {
    const result = budgetSources(
      [
        { label: "email", text: text(10) },
        { label: "page", text: text(10000) },
      ],
      5000,
    );
    expect(result.sources[0].text.length).toBe(10);
    expect(result.sources[1].text.length).toBeLessThanOrEqual(4990);
    expect(result.truncated.map((t) => t.label)).toEqual(["page"]);
  });

  it("never mutates the input", () => {
    const sources = [{ text: text(1000) }];
    budgetSources(sources, 10);
    expect(sources[0].text.length).toBe(1000);
  });

  it("copes with a budget smaller than the marker", () => {
    const [cut] = budgetSources([{ text: text(1000) }], 5).sources;
    expect(cut.text).toContain("characters omitted");
  });
});
