import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import type { FieldDescriptor } from "@sembl/core";
import { extractSchemas } from "../extractor/ast-extractor.js";

const fixturesDir = resolve(import.meta.dirname, "fixtures");

const result = extractSchemas({
  filePatterns: [resolve(fixturesDir, "annotated-schemas.ts")],
});

function field(schemaId: string, name: string): FieldDescriptor {
  const found = result.schemas[schemaId].fields.find((f) => f.name === name);
  expect(found, `${schemaId}.${name} should be extracted`).toBeDefined();
  return found!;
}

/** Warnings raised against a single `Class.property`. */
function warningsFor(schemaId: string, name: string): string[] {
  return result.warnings.filter((w) => w.startsWith(`${schemaId}.${name}: `));
}

describe("@Constrain", () => {
  it("reads string, numeric, array, and pattern bounds from the literal", () => {
    expect(field("Listing", "name").constraints).toEqual({
      maxLength: 40,
      minLength: 3,
    });
    expect(field("Listing", "nightlyRate").constraints).toEqual({
      minimum: 0,
      maximum: 10000,
    });
    expect(field("Listing", "photos").constraints).toEqual({
      minItems: 1,
      maxItems: 30,
    });
    expect(field("Listing", "reference").constraints).toEqual({
      pattern: "^[A-Z]{2}-\\d{4}$",
    });
  });

  it("reads a negative bound, which is a prefix minus rather than a literal", () => {
    expect(field("Listing", "latitude").constraints).toEqual({
      minimum: -90,
      maximum: 90,
    });
  });

  it("leaves constraints absent on a field that has no @Constrain", () => {
    expect(field("Listing", "amenities").constraints).toBeUndefined();
  });

  it("warns and skips a value that is a variable reference", () => {
    expect(field("UnreadableAnnotations", "fromVariable").constraints).toBeUndefined();
    expect(warningsFor("UnreadableAnnotations", "fromVariable")).toEqual([
      expect.stringContaining("MAX_TITLE"),
    ]);
  });

  it("warns and skips a value that is a computed expression", () => {
    expect(field("UnreadableAnnotations", "fromExpression").constraints).toBeUndefined();
    expect(warningsFor("UnreadableAnnotations", "fromExpression")).toEqual([
      expect.stringContaining("20 * 2"),
    ]);
  });

  it("warns and skips a spread entry", () => {
    expect(field("UnreadableAnnotations", "fromSpread").constraints).toBeUndefined();
    expect(warningsFor("UnreadableAnnotations", "fromSpread")).toEqual([
      expect.stringContaining("...SHARED_BOUNDS"),
    ]);
  });

  it("warns and ignores the decorator when the argument is not a literal at all", () => {
    expect(field("UnreadableAnnotations", "wholeArgument").constraints).toBeUndefined();
    expect(warningsFor("UnreadableAnnotations", "wholeArgument")).toEqual([
      expect.stringContaining("expects an inline object literal"),
    ]);
  });

  it("keeps the readable bounds when only one entry is unreadable", () => {
    expect(field("UnreadableAnnotations", "partiallyReadable").constraints).toEqual({
      maxLength: 40,
    });
    expect(warningsFor("UnreadableAnnotations", "partiallyReadable")).toEqual([
      expect.stringContaining("minLength"),
    ]);
  });

  it("rejects a key that is not a FieldConstraints property", () => {
    expect(field("UnreadableAnnotations", "unknownKey").constraints).toBeUndefined();
    const [warning] = warningsFor("UnreadableAnnotations", "unknownKey");
    expect(warning).toContain('"notAConstraint" is not a FieldConstraints property');
    // The message should list what is allowed, not just what is not.
    expect(warning).toContain("maxLength");
  });

  it("rejects a value of the wrong literal kind", () => {
    expect(field("UnreadableAnnotations", "wrongValueKind").constraints).toBeUndefined();
    expect(warningsFor("UnreadableAnnotations", "wrongValueKind")).toEqual([
      expect.stringContaining("not a number literal"),
    ]);
  });
});

describe("@ValuesFrom", () => {
  it("turns a string field into a dynamicEnum", () => {
    expect(field("Listing", "propertyType").type).toEqual({
      kind: "dynamicEnum",
      sourceId: "property-types",
    });
  });

  it("turns a string[] field into an array of dynamicEnum items", () => {
    expect(field("Listing", "amenities").type).toEqual({
      kind: "array",
      items: { kind: "dynamicEnum", sourceId: "amenities" },
    });
  });

  it("composes with @Constrain on the same field", () => {
    const policy = field("Listing", "cancellationPolicy");
    expect(policy.type).toEqual({
      kind: "dynamicEnum",
      sourceId: "cancellation-policies",
    });
    expect(policy.constraints).toEqual({ maxLength: 32 });
  });

  it("raises no warnings on the fields it legitimately applies to", () => {
    expect(warningsFor("Listing", "amenities")).toEqual([]);
    expect(warningsFor("Listing", "propertyType")).toEqual([]);
    expect(warningsFor("Listing", "cancellationPolicy")).toEqual([]);
  });

  it.each([
    ["count", { kind: "number" }, "number"],
    ["nested", { kind: "object", nestedSchemaId: "Listing" }, "object"],
    [
      "nestedList",
      { kind: "array", items: { kind: "object", nestedSchemaId: "Listing" } },
      "object[]",
    ],
    ["status", { kind: "enum", values: ["draft", "published"] }, "enum"],
  ])(
    "warns and leaves the type alone when applied to %s",
    (name, expectedType, described) => {
      expect(field("MisplacedValuesFrom", name).type).toEqual(expectedType);
      const [warning] = warningsFor("MisplacedValuesFrom", name);
      expect(warning).toContain("applies to a string or string[] field");
      expect(warning).toContain(described);
    },
  );

  it("reads a format and rejects one it does not know", () => {
    expect(field("Listing", "website").constraints).toEqual({ format: "url" });
    expect(field("UnreadableAnnotations", "unknownFormat").constraints).toBeUndefined();
    const [warning] = warningsFor("UnreadableAnnotations", "unknownFormat");
    expect(warning).toContain('format "phone" is not a known format');
  });
});
