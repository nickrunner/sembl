import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import type { FieldDescriptor } from "@sembl/core";
import { extractSchemas } from "../extractor/ast-extractor.js";

const fixturesDir = resolve(import.meta.dirname, "fixtures");

function extractFixture(name: string) {
  return extractSchemas({ filePatterns: [resolve(fixturesDir, name)] });
}

describe("inline anonymous object types", () => {
  const result = extractFixture("inline-object-schemas.ts");

  function field(schemaId: string, name: string): FieldDescriptor {
    return result.schemas[schemaId].fields.find((f) => f.name === name)!;
  }

  /** The nested schema an object-typed field (or array of them) points at. */
  function nestedIdOf(schemaId: string, name: string): string {
    const type = field(schemaId, name).type;
    if (type.kind === "array") {
      expect(type.items.kind).toBe("object");
      return (type.items as { nestedSchemaId: string }).nestedSchemaId;
    }
    expect(type.kind).toBe("object");
    return (type as { nestedSchemaId: string }).nestedSchemaId;
  }

  it("no longer resolves an inline object to the 'unknown' sentinel", () => {
    for (const schema of Object.values(result.schemas)) {
      for (const f of schema.fields) {
        expect(JSON.stringify(f.type)).not.toContain('"unknown"');
      }
    }
  });

  it("synthesizes and registers a schema for an inline array element type", () => {
    const id = nestedIdOf("StayDetails", "nearbyAttractions");
    expect(id).toMatch(/^StayDetails_nearbyAttractions__[0-9a-f]{8}$/);

    const synthesized = result.schemas[id];
    expect(synthesized).toBeDefined();
    expect(synthesized.id).toBe(id);
    expect(synthesized.description).toContain("StayDetails.nearbyAttractions");
    expect(synthesized.fields).toEqual([
      { name: "description", description: "", type: { kind: "string" }, required: true },
      { name: "distance", description: "", type: { kind: "number" }, required: true },
    ]);
  });

  it("carries optionality of inline members through", () => {
    const contact = result.schemas[nestedIdOf("StayDetails", "contact")];
    expect(contact.fields.find((f) => f.name === "name")!.required).toBe(true);
    expect(contact.fields.find((f) => f.name === "phone")!.required).toBe(false);
  });

  it("synthesizes schemas for inline types nested inside inline types", () => {
    const host = result.schemas[nestedIdOf("StayDetails", "host")];
    const addressField = host.fields.find((f) => f.name === "address")!;
    expect(addressField.type.kind).toBe("object");

    const addressId = (addressField.type as { nestedSchemaId: string }).nestedSchemaId;
    expect(addressId).toMatch(/^StayDetails_host_address__[0-9a-f]{8}$/);
    expect(result.schemas[addressId].fields.map((f) => f.name)).toEqual([
      "city",
      "country",
    ]);
  });

  it("gives every synthesized schema an id that is a valid TS identifier", () => {
    // The emitter turns the id into a filename and an exported binding, so a
    // dot or a bracket from the source path would produce output that will not
    // compile.
    for (const id of Object.keys(result.schemas)) {
      expect(id).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
    }
  });

  it("derives ids that are stable across runs", () => {
    const again = extractFixture("inline-object-schemas.ts");
    expect(Object.keys(again.schemas).sort()).toEqual(
      Object.keys(result.schemas).sort(),
    );
  });

  it("keeps the same property name in different classes apart", () => {
    expect(nestedIdOf("OtherStay", "contact")).not.toBe(
      nestedIdOf("StayDetails", "contact"),
    );
  });

  it("raises no warnings — an inline object is supported, not tolerated", () => {
    expect(result.warnings).toEqual([]);
  });
});

describe("types the schema contract cannot express", () => {
  const result = extractFixture("unsupported-types.ts");

  function warningFor(name: string): string {
    const found = result.warnings.filter((w) =>
      w.startsWith(`ExoticListing.${name}: `),
    );
    expect(found, `expected exactly one warning for ${name}`).toHaveLength(1);
    return found[0];
  }

  it.each([
    ["bookingLinks", "Record<string, string>"],
    ["partnerLinks", "{ [partner: string]: string; }"],
    ["mixedUnion", '"auto" | 5'],
    ["mixedShape", "string | UndecoratedOwner"],
  ])("warns for %s, naming the class, the property, and the type", (name, typeText) => {
    const warning = warningFor(name);
    expect(warning).toContain(`ExoticListing.${name}`);
    expect(warning).toContain(typeText);
  });

  it("explains that a map has no FieldType equivalent rather than just failing", () => {
    // FieldType is a frozen contract with no map kind, so a precise warning is
    // all the compiler can honestly offer here.
    const warning = warningFor("bookingLinks");
    expect(warning).toContain("no FieldType equivalent");
    expect(warning).toContain("@Schema class");
  });

  it.each(["publishedAt", "rateCalendar", "owner"])(
    "warns that %s points at a nested schema nothing in the bundle answers to",
    (name) => {
      const warning = warningFor(name);
      expect(warning).toContain("is not a @Schema-decorated class");
    },
  );

  it("names the real type of a lib global rather than 'any'", () => {
    expect(warningFor("rateCalendar")).toContain("Map<string, number>");
  });

  it("does not warn for an optional boolean, which is a union underneath", () => {
    const field = result.schemas["ExoticListing"].fields.find(
      (f) => f.name === "instantBook",
    )!;
    expect(field.type).toEqual({ kind: "boolean" });
    expect(result.warnings.filter((w) => w.includes("instantBook"))).toEqual([]);
  });

  it("widens a union of number literals to number without warning", () => {
    const field = result.schemas["ExoticListing"].fields.find(
      (f) => f.name === "maxGuests",
    )!;
    expect(field.type).toEqual({ kind: "number" });
    expect(result.warnings.filter((w) => w.includes("maxGuests"))).toEqual([]);
  });

  it("emits every unsupported field rather than dropping it", () => {
    // A warned field still extracts, so one bad property does not silently
    // shrink the schema the model is asked to fill.
    expect(result.schemas["ExoticListing"].fields).toHaveLength(9);
  });
});

describe("warnings on clean input", () => {
  it("stays silent for schemas that use only supported types", () => {
    expect(extractFixture("basic-schemas.ts").warnings).toEqual([]);
  });
});
