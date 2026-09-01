import { describe, it, expect } from "vitest";
import { runtimeSchemaToJsonSchema, toOpenAIJsonSchema } from "../schema/json-schema.js";
import type { RuntimeSchema, SchemaBundle } from "../schema/types.js";

const addressSchema: RuntimeSchema = {
  id: "Address",
  description: "A location.",
  fields: [
    { name: "street", description: "Street name", type: { kind: "string" }, required: false },
    { name: "city", description: "City name", type: { kind: "string" }, required: true },
  ],
};

describe("runtimeSchemaToJsonSchema", () => {
  it("converts a simple schema", () => {
    const result = runtimeSchemaToJsonSchema(addressSchema);

    expect(result.type).toBe("object");
    expect(result.additionalProperties).toBe(false);
    expect(result.description).toBe("A location.");
    // All fields in required (OpenAI strict mode)
    expect(result.required).toEqual(["street", "city"]);
  });

  it("wraps optional fields in anyOf with null", () => {
    const result = runtimeSchemaToJsonSchema(addressSchema);
    const props = result.properties as Record<string, Record<string, unknown>>;

    // Optional field uses anyOf
    expect(props.street.anyOf).toBeDefined();
    expect(props.street.anyOf).toEqual([
      { type: "string", description: "Street name" },
      { type: "null" },
    ]);

    // Required field is direct
    expect(props.city.type).toBe("string");
    expect(props.city.description).toBe("City name");
  });

  it("inlines nested schemas", () => {
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

    const result = runtimeSchemaToJsonSchema(profileSchema, bundle);
    const props = result.properties as Record<string, Record<string, unknown>>;

    // Should be inlined, not a $ref
    const addressProp = props.address;
    expect(addressProp.anyOf).toBeDefined();
    const addressObj = (addressProp.anyOf as unknown[])[0] as Record<string, unknown>;
    expect(addressObj.type).toBe("object");
    expect(addressObj.additionalProperties).toBe(false);
  });
});

describe("toOpenAIJsonSchema", () => {
  it("wraps schema with name and strict flag", () => {
    const result = toOpenAIJsonSchema(addressSchema);

    expect(result.name).toBe("Address");
    expect(result.strict).toBe(true);
    expect(result.schema).toBeDefined();
    expect((result.schema as Record<string, unknown>).type).toBe("object");
  });
});

describe("runtimeSchemaToJsonSchema dialects", () => {
  it("keeps OpenAI strict mode as the default", () => {
    const result = runtimeSchemaToJsonSchema(addressSchema);
    expect(result.required).toEqual(["street", "city"]);
  });

  it("omits optional fields from required in the standard dialect", () => {
    const result = runtimeSchemaToJsonSchema(addressSchema, undefined, {
      dialect: "standard",
    });
    const props = result.properties as Record<string, Record<string, unknown>>;

    expect(result.required).toEqual(["city"]);
    expect(props.street.anyOf).toBeUndefined();
    expect(props.street.type).toBe("string");
  });

  it("propagates the dialect into inlined nested schemas", () => {
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
    const bundle: SchemaBundle = {
      schemas: { Address: addressSchema, Profile: profileSchema },
    };

    const result = runtimeSchemaToJsonSchema(profileSchema, bundle, {
      dialect: "standard",
    });
    const props = result.properties as Record<string, Record<string, unknown>>;

    expect(props.address.required).toEqual(["city"]);
  });

  it("propagates the dialect through arrays of nested schemas", () => {
    const tripSchema: RuntimeSchema = {
      id: "Trip",
      description: "A trip.",
      fields: [
        {
          name: "stops",
          description: "Stops along the way",
          type: { kind: "array", items: { kind: "object", nestedSchemaId: "Address" } },
          required: true,
        },
      ],
    };
    const bundle: SchemaBundle = {
      schemas: { Address: addressSchema, Trip: tripSchema },
    };

    const result = runtimeSchemaToJsonSchema(tripSchema, bundle, {
      dialect: "standard",
    });
    const props = result.properties as Record<string, Record<string, unknown>>;
    const items = props.stops.items as Record<string, unknown>;

    expect(items.required).toEqual(["city"]);
  });
});

describe("dynamic enums", () => {
  const staySchema: RuntimeSchema = {
    id: "Stay",
    description: "A stay.",
    fields: [
      {
        name: "amenities",
        description: "Amenities offered.",
        type: { kind: "array", items: { kind: "dynamicEnum", sourceId: "amenities" } },
        required: true,
      },
    ],
  };

  it("emits a resolved source as an enum", () => {
    const props = runtimeSchemaToJsonSchema(staySchema, undefined, {
      resolvedEnums: { amenities: ["pool", "sauna"] },
    }).properties as Record<string, Record<string, unknown>>;

    expect((props.amenities.items as Record<string, unknown>).enum).toEqual(["pool", "sauna"]);
  });

  it("emits an unresolved source as a plain string, not an empty enum", () => {
    const props = runtimeSchemaToJsonSchema(staySchema).properties as Record<
      string,
      Record<string, unknown>
    >;
    const items = props.amenities.items as Record<string, unknown>;

    expect(items.type).toBe("string");
    expect(items.enum).toBeUndefined();
  });

  it("treats an empty resolved source as unresolved", () => {
    const props = runtimeSchemaToJsonSchema(staySchema, undefined, {
      resolvedEnums: { amenities: [] },
    }).properties as Record<string, Record<string, unknown>>;

    expect((props.amenities.items as Record<string, unknown>).enum).toBeUndefined();
  });
});
