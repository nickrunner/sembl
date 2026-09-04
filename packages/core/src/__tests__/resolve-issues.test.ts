import { describe, it, expect } from "vitest";
import { resolveIssues } from "../coerce/resolve-issues.js";
import { validateStrict, validatePartial } from "../coerce/validator.js";
import type { RuntimeSchema, SchemaBundle } from "../schema/types.js";

const address: RuntimeSchema = {
  id: "Address",
  description: "Where a property is.",
  fields: [
    { name: "city", description: "City", type: { kind: "string" }, required: true },
    {
      name: "zip",
      description: "Postal code",
      type: { kind: "string" },
      required: false,
      constraints: { pattern: "^\\d{5}$" },
    },
  ],
};

const listing: RuntimeSchema = {
  id: "Listing",
  description: "A rental listing.",
  fields: [
    {
      name: "name",
      description: "Display name",
      type: { kind: "string" },
      required: true,
      constraints: { maxLength: 10 },
    },
    {
      name: "sleeps",
      description: "Guest capacity",
      type: { kind: "number" },
      required: false,
      constraints: { minimum: 1, maximum: 20 },
    },
    {
      name: "tags",
      description: "Tags",
      type: { kind: "array", items: { kind: "string" } },
      required: false,
      constraints: { maxItems: 2, maxLength: 5 },
    },
    {
      name: "kind",
      description: "Property kind",
      type: { kind: "enum", values: ["house", "flat"] },
      required: false,
    },
    {
      name: "region",
      description: "Region",
      type: { kind: "dynamicEnum", sourceId: "regions" },
      required: false,
    },
    {
      name: "address",
      description: "Address",
      type: { kind: "object", nestedSchemaId: "Address" },
      required: false,
    },
    {
      name: "owner",
      description: "Owner",
      type: { kind: "object", nestedSchemaId: "Address" },
      required: true,
    },
  ],
};

const bundle: SchemaBundle = { schemas: { Listing: listing, Address: address } };
const resolvedEnums = { regions: ["north", "south"] };

function run(
  data: Record<string, unknown>,
  policy: "throw" | "drop" | "clamp",
  mode: "coerce" | "partialCoerce" = "partialCoerce",
) {
  const validate = mode === "coerce" ? validateStrict : validatePartial;
  const issues = validate(data, listing, bundle, { resolvedEnums });
  return resolveIssues(data, issues, listing, { bundle, resolvedEnums, mode, policy });
}

describe("resolveIssues", () => {
  it("resolves nothing under the throw policy", () => {
    const data = { name: "x", sleeps: 200 };
    const result = run(data, "throw");
    expect(result.resolved).toEqual([]);
    expect(result.unresolved.map((i) => i.path)).toEqual(["sleeps"]);
    expect(result.data).toBe(data);
  });

  it("never mutates the input", () => {
    const data = { name: "x", sleeps: 200, tags: ["a", "b", "c"] };
    const snapshot = structuredClone(data);
    run(data, "drop");
    run(data, "clamp");
    expect(data).toEqual(snapshot);
  });

  describe("drop", () => {
    it("drops a wrongly typed optional field", () => {
      const result = run({ name: "x", sleeps: "lots" }, "drop");
      expect(result.data).toEqual({ name: "x" });
      expect(result.resolved).toMatchObject([
        { path: "sleeps", resolution: "dropped", resolvedPath: "sleeps" },
      ]);
      expect(result.unresolved).toEqual([]);
    });

    it("drops a bad static enum value and a bad dynamic enum value", () => {
      const result = run({ name: "x", kind: "castle", region: "east" }, "drop");
      expect(result.data).toEqual({ name: "x" });
      expect(result.resolved.map((r) => r.resolvedPath).sort()).toEqual(["kind", "region"]);
    });

    it("drops only the offending array element", () => {
      const result = run({ name: "x", tags: ["ok", "much too long"] }, "drop");
      expect(result.data).toEqual({ name: "x", tags: ["ok"] });
      expect(result.resolved).toMatchObject([
        { path: "tags[1]", resolution: "dropped", resolvedPath: "tags[1]" },
      ]);
    });

    it("removes elements without leaving stale indexes behind", () => {
      const result = run({ name: "x", tags: ["toolong1", "ok", "toolong2"] }, "drop");
      expect(result.data).toEqual({ name: "x", tags: ["ok"] });
      expect(result.unresolved).toEqual([]);
    });

    it("drops an optional nested field rather than its parent", () => {
      const result = run({ name: "x", address: { city: "Boise", zip: "abc" } }, "drop");
      expect(result.data).toEqual({ name: "x", address: { city: "Boise" } });
      expect(result.resolved[0].resolvedPath).toBe("address.zip");
    });

    it("walks up to the nearest optional ancestor when the leaf is required", () => {
      const result = run({ name: "x", address: { city: 42 } }, "drop");
      expect(result.data).toEqual({ name: "x" });
      expect(result.resolved[0]).toMatchObject({
        path: "address.city",
        resolvedPath: "address",
      });
    });

    it("drops a required top-level field in partial mode", () => {
      const result = run({ name: 42 }, "drop", "partialCoerce");
      expect(result.data).toEqual({});
      expect(result.unresolved).toEqual([]);
    });

    it("leaves a required top-level field alone in strict mode", () => {
      const result = run({ name: 42, owner: { city: "Boise" } }, "drop", "coerce");
      expect(result.data).toEqual({ name: 42, owner: { city: "Boise" } });
      expect(result.resolved).toEqual([]);
      expect(result.unresolved.map((i) => i.path)).toEqual(["name"]);
    });

    it("leaves a required path inside a required object alone", () => {
      const result = run({ name: "x", owner: { city: 42 } }, "drop", "coerce");
      expect(result.unresolved.map((i) => i.path)).toEqual(["owner.city"]);
      expect(result.data).toEqual({ name: "x", owner: { city: 42 } });
    });

    it("records every issue that the removed subtree covered", () => {
      const result = run({ name: "x", address: { city: 1, zip: "abc" } }, "drop");
      expect(result.resolved.map((r) => r.path).sort()).toEqual([
        "address.city",
        "address.zip",
      ]);
      expect(new Set(result.resolved.map((r) => r.resolvedPath))).toEqual(new Set(["address"]));
    });

    it("ignores a field the schema does not describe", () => {
      const issues = [{ path: "mystery", message: "Made up", received: 1 }];
      const result = resolveIssues({ name: "x", mystery: 1 }, issues, listing, {
        bundle,
        mode: "partialCoerce",
        policy: "drop",
      });
      expect(result.unresolved).toEqual(issues);
    });
  });

  describe("clamp", () => {
    it("truncates a string to maxLength", () => {
      const result = run({ name: "a much longer name" }, "clamp");
      expect(result.data).toEqual({ name: "a much lon" });
      expect(result.resolved).toMatchObject([
        { path: "name", resolution: "clamped", replacement: "a much lon" },
      ]);
    });

    it("clamps a number into its range", () => {
      expect(run({ name: "x", sleeps: 200 }, "clamp").data).toEqual({ name: "x", sleeps: 20 });
      expect(run({ name: "x", sleeps: -3 }, "clamp").data).toEqual({ name: "x", sleeps: 1 });
    });

    it("cuts an array down to maxItems", () => {
      const result = run({ name: "x", tags: ["a", "b", "c"] }, "clamp");
      expect(result.data).toEqual({ name: "x", tags: ["a", "b"] });
    });

    it("clamps an element to the parent field's string bounds", () => {
      const result = run({ name: "x", tags: ["abcdefgh"] }, "clamp");
      expect(result.data).toEqual({ name: "x", tags: ["abcde"] });
      expect(result.resolved[0].resolvedPath).toBe("tags[0]");
    });

    it("falls back to dropping when no clamp applies", () => {
      const result = run({ name: "x", sleeps: "lots", kind: "castle" }, "clamp");
      expect(result.data).toEqual({ name: "x" });
      expect(result.resolved.every((r) => r.resolution === "dropped")).toBe(true);
    });

    it("drops a value a clamp cannot rescue", () => {
      // pattern is not clampable, so the nested optional field goes.
      const result = run({ name: "x", address: { city: "Boise", zip: "12" } }, "clamp");
      expect(result.data).toEqual({ name: "x", address: { city: "Boise" } });
    });

    it("clamps a required field in strict mode rather than failing", () => {
      const result = run({ name: "a much longer name", owner: { city: "Boise" } }, "clamp", "coerce");
      expect(result.data.name).toBe("a much lon");
      expect(result.unresolved).toEqual([]);
    });
  });
});
