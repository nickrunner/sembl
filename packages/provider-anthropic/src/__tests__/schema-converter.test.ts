import { describe, it, expect } from "vitest";
import { toInputSchema, toToolName } from "../schema-converter.js";
import type { RuntimeSchema, SchemaBundle } from "@sembl/core";

const addressSchema: RuntimeSchema = {
  id: "Address",
  description: "A location.",
  fields: [
    { name: "street", description: "Street name", type: { kind: "string" }, required: false },
    { name: "city", description: "City name", type: { kind: "string" }, required: true },
  ],
};

describe("toToolName", () => {
  it("derives a tool name from the schema id", () => {
    expect(toToolName("Address")).toBe("extract_Address");
  });

  it("replaces characters Anthropic's tool-name pattern rejects", () => {
    expect(toToolName("Stay.Details v2")).toBe("extract_Stay_Details_v2");
  });

  it("stays within the 64-character limit", () => {
    expect(toToolName("A".repeat(200)).length).toBeLessThanOrEqual(64);
  });
});

describe("toInputSchema", () => {
  it("lists only genuinely required fields in required", () => {
    const result = toInputSchema(addressSchema);

    expect(result.type).toBe("object");
    expect(result.additionalProperties).toBe(false);
    expect(result.required).toEqual(["city"]);
  });

  it("leaves optional fields as plain types rather than nullable unions", () => {
    const props = toInputSchema(addressSchema).properties as Record<
      string,
      Record<string, unknown>
    >;

    expect(props.street.anyOf).toBeUndefined();
    expect(props.street.type).toBe("string");
    expect(props.street.description).toBe("Street name");
  });

  it("inlines nested schemas from the bundle in the same dialect", () => {
    const profileSchema: RuntimeSchema = {
      id: "Profile",
      description: "A profile.",
      fields: [
        {
          name: "address",
          description: "User address",
          type: { kind: "object", nestedSchemaId: "Address" },
          required: false,
        },
      ],
    };
    const bundle: SchemaBundle = {
      schemas: { Address: addressSchema, Profile: profileSchema },
    };

    const props = toInputSchema(profileSchema, bundle).properties as Record<
      string,
      Record<string, unknown>
    >;

    expect(props.address.type).toBe("object");
    expect(props.address.required).toEqual(["city"]);
    expect(props.address.anyOf).toBeUndefined();
  });

  it("emits an empty nested object when the bundle is missing", () => {
    const profileSchema: RuntimeSchema = {
      id: "Profile",
      description: "A profile.",
      fields: [
        {
          name: "address",
          description: "User address",
          type: { kind: "object", nestedSchemaId: "Address" },
          required: true,
        },
      ],
    };

    const props = toInputSchema(profileSchema).properties as Record<
      string,
      Record<string, unknown>
    >;

    expect(props.address.properties).toBeUndefined();
  });
});

describe("toInputSchema with resolved enums", () => {
  const staySchema: RuntimeSchema = {
    id: "Stay",
    description: "A stay.",
    fields: [
      {
        name: "amenities",
        description: "Amenities the property offers.",
        type: { kind: "array", items: { kind: "dynamicEnum", sourceId: "amenities" } },
        required: true,
      },
      {
        name: "propertyType",
        description: "What kind of property this is.",
        type: { kind: "dynamicEnum", sourceId: "propertyTypes" },
        required: true,
      },
    ],
  };

  it("emits resolved sources as enums", () => {
    const props = toInputSchema(staySchema, undefined, {
      amenities: ["pool", "hot-tub-private"],
      propertyTypes: ["cabin", "a-frame"],
    }).properties as Record<string, Record<string, unknown>>;

    expect((props.amenities.items as Record<string, unknown>).enum).toEqual([
      "pool",
      "hot-tub-private",
    ]);
    expect(props.propertyType.enum).toEqual(["cabin", "a-frame"]);
  });

  it("leaves an unresolved source as a free-form string", () => {
    const props = toInputSchema(staySchema, undefined, {
      amenities: ["pool"],
    }).properties as Record<string, Record<string, unknown>>;

    expect(props.propertyType.type).toBe("string");
    expect(props.propertyType.enum).toBeUndefined();
  });
});
