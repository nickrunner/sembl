import { describe, it, expect } from "vitest";
import { FeedError, getPath, jsonItems, jsonSource, jsonToText } from "../index.js";
import { apiJson } from "./fixtures.js";

describe("jsonToText", () => {
  it("renders an indented key: value outline with numbered items, nulls and empty containers", () => {
    const text = jsonToText(apiJson);
    expect(text).toContain("meta:\n  requestId: req-9f8e7d\n  generatedAt: 2026-03-01T00:00:00Z\n  page: 1\n  total: 2");
    expect(text).toContain("data:\n  listings:\n    1.\n      id: sc-101\n      title: Sea Cabin & Sauna");
    expect(text).toContain("amenities:\n        1. wifi\n        2. sauna\n        3. hot tub");
    expect(text).toContain("photos: (empty list)");
    expect(text).toContain("rating: null");
    expect(text).toContain("extras: (empty object)");
    expect(text).not.toMatch(/[{}"]/);
  });

  it("keeps long and multi-line strings whole, indented under their key", () => {
    const text = jsonToText({ description: "A cabin by the sea.\nSleeps 6 in two bedrooms.", note: "x".repeat(500) });
    expect(text).toContain("description:\n  A cabin by the sea.\n  Sleeps 6 in two bedrooms.");
    expect(text).toContain(`note: ${"x".repeat(500)}`);
  });

  it("renders scalars, top-level arrays and empty roots on their own", () => {
    expect(jsonToText("hello")).toBe("hello");
    expect(jsonToText(42)).toBe("42");
    expect(jsonToText(null)).toBe("null");
    expect(jsonToText([])).toBe("(empty list)");
    expect(jsonToText({})).toBe("(empty object)");
    expect(jsonToText(["a", { b: 1 }])).toBe("1. a\n2.\n  b: 1");
  });

  it("omits keys anywhere in the tree", () => {
    const text = jsonToText(apiJson, { omitKeys: ["requestId", "email", "phone"] });
    expect(text).not.toContain("requestId");
    expect(text).not.toContain("@coastal-stays.example");
    expect(text).not.toContain("+47");
    expect(text).toContain("name: Ann Berg");
  });

  it("redacts by path: a replacement value or undefined to drop", () => {
    const paths: string[] = [];
    const text = jsonToText(apiJson, {
      redact: (path, value) => {
        paths.push(path);
        if (path.endsWith(".email")) return "[redacted]";
        if (path.endsWith(".phone")) return undefined;
        return value;
      },
    });
    expect(text).toContain("email: [redacted]");
    expect(text).not.toContain("phone");
    expect(paths).toContain("data.listings[0].host.email");
    expect(paths).toContain("data.listings[1].amenities[0]");
    expect(paths).toContain("meta.page");
  });

  it("redacts array elements to a placeholder rather than renumbering", () => {
    const text = jsonToText({ list: ["keep", "drop", "keep"] }, { redact: (_p, v) => (v === "drop" ? undefined : v) });
    expect(text).toBe("list:\n  1. keep\n  2. (redacted)\n  3. keep");
  });

  it("caps array length and says how many were left out", () => {
    const text = jsonToText({ n: [1, 2, 3, 4, 5] }, { maxArrayItems: 2 });
    expect(text).toBe("n:\n  1. 1\n  2. 2\n  … 3 more items not shown");
  });

  it("collapses containers past maxDepth to compact JSON", () => {
    expect(jsonToText({ a: { b: { c: 1 } }, d: [1] }, { maxDepth: 0 })).toBe('a: {"b":{"c":1}}\nd: [1]');
    expect(jsonToText({ a: { b: { c: 1 } } }, { maxDepth: 1 })).toBe('a:\n  b: {"c":1}');
  });

  it("marks circular references instead of looping", () => {
    const loop: Record<string, unknown> = { name: "x" };
    loop.self = loop;
    expect(jsonToText(loop)).toBe("name: x\nself: (circular)");
  });

  it("writes dates, bigints and quoted-empty strings readably", () => {
    expect(jsonToText({ when: new Date(Date.UTC(2026, 2, 1)), big: 10n, empty: "" })).toBe(
      "when: 2026-03-01T00:00:00.000Z\nbig: 10\nempty: \"\"",
    );
  });
});

describe("jsonSource", () => {
  it("builds a labelled source, or an unlabelled one", () => {
    expect(jsonSource({ a: 1 }, "API")).toEqual({ label: "API", text: "a: 1" });
    expect(jsonSource({ a: 1 })).toEqual({ text: "a: 1" });
  });
});

describe("getPath", () => {
  it("reads dot and bracket paths", () => {
    expect(getPath(apiJson, "data.listings[1].address.city")).toBe("Manchester");
    expect(getPath(apiJson, 'data["listings"][0].id')).toBe("sc-101");
    expect(getPath({ "odd key": [1] }, "['odd key'][0]")).toBe(1);
    expect(getPath(apiJson, "")).toBe(apiJson);
    expect(getPath(apiJson, "data.nothing.here")).toBeUndefined();
  });

  it("rejects a path it cannot read", () => {
    expect(() => getPath(apiJson, "data..x")).toThrow(FeedError);
    expect(() => getPath(apiJson, "data[x]")).toThrow(/unexpected/);
  });
});

describe("jsonItems", () => {
  it("makes one numbered source per array element", () => {
    const items = jsonItems(apiJson, "data.listings", "Listing", { omitKeys: ["email"] });
    expect(items.map((s) => s.label)).toEqual(["Listing 1", "Listing 2"]);
    expect(items[0].text).toContain("id: sc-101");
    expect(items[0].text).not.toContain("cf-202");
    expect(items[1].text).toContain("city: Manchester");
    expect(items[1].text).not.toContain("email");
    expect(jsonItems([{ a: 1 }], "")[0].label).toBe("Item 1");
  });

  it("throws clearly for a missing path or a non-array", () => {
    expect(() => jsonItems(apiJson, "data.items")).toThrow('Nothing at path "data.items"');
    expect(() => jsonItems(apiJson, "meta")).toThrow('Expected an array at path "meta", got object');
  });
});
