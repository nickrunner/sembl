import { describe, it, expect, expectTypeOf } from "vitest";
import { defineSchema, field, bundleOf } from "../schema/define.js";
import type { Infer } from "../schema/define.js";
import { coerce } from "../coerce/coerce.js";
import { runtimeSchemaToJsonSchema } from "../schema/json-schema.js";
import type { Provider } from "../provider/types.js";

const Address = defineSchema("Address", "Where a property is.", {
  street: field.string("Street number and street name.").optional(),
  city: field.string("City or municipality."),
  zip: field.string("Postal code.").optional(),
});

const Listing = defineSchema("Listing", "A short-term rental listing.", {
  name: field.string("Display name.", { maxLength: 40 }),
  sleeps: field.number("Guest capacity.", { minimum: 1, maximum: 20 }).optional(),
  kind: field.enum(["house", "flat"], "Property kind.").optional(),
  amenities: field.valuesFrom("amenities", "What the property offers.", { maxLength: 32 }).array({
    maxItems: 5,
  }),
  address: field.object(Address, "Where the property is.").optional(),
  photos: field.array(field.string("A photo URL."), { maxItems: 30 }).optional(),
  featured: field.boolean("Whether the host paid for placement."),
});

describe("defineSchema", () => {
  it("produces the descriptors the compiler would, in declaration order", () => {
    expect(Address.fields).toEqual([
      { name: "street", description: "Street number and street name.", type: { kind: "string" }, required: false },
      { name: "city", description: "City or municipality.", type: { kind: "string" }, required: true },
      { name: "zip", description: "Postal code.", type: { kind: "string" }, required: false },
    ]);
    expect(Address.id).toBe("Address");
    expect(Address.description).toBe("Where a property is.");
  });

  it("covers every field type and carries constraints", () => {
    const byName = Object.fromEntries(Listing.fields.map((f) => [f.name, f]));
    expect(byName.name).toEqual({
      name: "name", description: "Display name.", type: { kind: "string" }, required: true,
      constraints: { maxLength: 40 },
    });
    expect(byName.sleeps.type).toEqual({ kind: "number" });
    expect(byName.sleeps.constraints).toEqual({ minimum: 1, maximum: 20 });
    expect(byName.kind.type).toEqual({ kind: "enum", values: ["house", "flat"] });
    expect(byName.amenities).toEqual({
      name: "amenities", description: "What the property offers.",
      type: { kind: "array", items: { kind: "dynamicEnum", sourceId: "amenities" } },
      required: true,
      constraints: { maxLength: 32, maxItems: 5 },
    });
    expect(byName.address.type).toEqual({ kind: "object", nestedSchemaId: "Address" });
    expect(byName.photos.type).toEqual({ kind: "array", items: { kind: "string" } });
    expect(byName.photos.constraints).toEqual({ maxItems: 30 });
    expect(byName.featured.type).toEqual({ kind: "boolean" });
  });

  it("omits the constraints key when there are none", () => {
    expect("constraints" in Address.fields[0]).toBe(false);
  });

  it("bundles itself and every schema it refers to", () => {
    expect(Object.keys(Listing.bundle.schemas).sort()).toEqual(["Address", "Listing"]);
    expect(Listing.bundle.schemas.Address).toEqual({
      id: "Address",
      description: "Where a property is.",
      fields: Address.fields,
    });
    expect(bundleOf(Listing)).toBe(Listing.bundle);
    expect(bundleOf({ id: "X", description: "", fields: [] })).toBeUndefined();
  });

  it("builders are immutable and reusable", () => {
    const base = field.string("Name.");
    const optional = base.optional();
    expect(base.required).toBe(true);
    expect(optional.required).toBe(false);
    expect(base.constrain({ maxLength: 3 }).constraints).toEqual({ maxLength: 3 });
    expect(base.constraints).toBeUndefined();
    expect(base.describe("Other.").description).toBe("Other.");
  });

  it("rejects conflicting nested schemas that share an id", () => {
    const A1 = defineSchema("Nested", "One.", { a: field.string("A.") });
    const A2 = defineSchema("Nested", "Two.", { b: field.string("B.") });
    expect(() =>
      defineSchema("Parent", "P.", {
        one: field.object(A1, "One."),
        two: field.object(A2, "Two."),
      }),
    ).toThrow(/two different schemas/);
  });

  it("rejects an empty id and an empty enum", () => {
    expect(() => defineSchema(" ", "d", {})).toThrow(RangeError);
    expect(() => field.enum([], "d")).toThrow(RangeError);
  });

  it("converts to JSON Schema like any RuntimeSchema", () => {
    const json = runtimeSchemaToJsonSchema(Listing, Listing.bundle) as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(json.properties)).toContain("address");
  });

  it("coerces with its own bundle when none is passed", async () => {
    let sawBundle = false;
    const provider: Provider = {
      async complete(request) {
        sawBundle = request.bundle?.schemas.Address !== undefined;
        return {
          data: {
            name: "Cabin",
            amenities: [],
            featured: false,
            address: { city: "Boise" },
          },
        };
      },
    };
    const result = await coerce<Infer<typeof Listing>>("x", { provider, schema: Listing });
    expect(sawBundle).toBe(true);
    expect(result.address?.city).toBe("Boise");
  });

  it("infers the TypeScript type", () => {
    type L = Infer<typeof Listing>;
    expectTypeOf<L>().toEqualTypeOf<{
      name: string;
      sleeps?: number;
      kind?: "house" | "flat";
      amenities: string[];
      address?: { street?: string; city: string; zip?: string };
      photos?: string[];
      featured: boolean;
    }>();
    expectTypeOf<Infer<typeof Address>>().toEqualTypeOf<{
      street?: string;
      city: string;
      zip?: string;
    }>();
  });
});
