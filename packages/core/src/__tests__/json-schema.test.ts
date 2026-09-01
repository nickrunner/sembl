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

describe("runtimeSchemaToJsonSchema with dynamic enums", () => {
  const listingSchema: RuntimeSchema = {
    id: "Listing",
    description: "A listing.",
    fields: [
      {
        name: "propertyType",
        description: "Kind of property",
        type: { kind: "dynamicEnum", sourceId: "propertyTypes" },
        required: true,
      },
      {
        name: "amenities",
        description: "Amenity slugs",
        type: { kind: "array", items: { kind: "dynamicEnum", sourceId: "amenities" } },
        required: true,
      },
    ],
  };

  it("emits resolved values as a string enum", () => {
    const result = runtimeSchemaToJsonSchema(listingSchema, undefined, {
      resolvedEnums: { propertyTypes: ["villa", "cabin"], amenities: ["wifi"] },
    });
    const props = result.properties as Record<string, Record<string, unknown>>;

    expect(props.propertyType).toMatchObject({
      type: "string",
      enum: ["villa", "cabin"],
    });
    expect(props.amenities.items).toMatchObject({
      type: "string",
      enum: ["wifi"],
    });
  });

  it("falls back to a free-form string when the source is unresolved", () => {
    const result = runtimeSchemaToJsonSchema(listingSchema, undefined, {
      resolvedEnums: { amenities: ["wifi"] },
    });
    const props = result.properties as Record<string, Record<string, unknown>>;

    expect(props.propertyType.type).toBe("string");
    expect(props.propertyType.enum).toBeUndefined();
  });

  it("falls back to a free-form string when no enums were resolved at all", () => {
    const result = runtimeSchemaToJsonSchema(listingSchema);
    const props = result.properties as Record<string, Record<string, unknown>>;

    expect(props.propertyType.enum).toBeUndefined();
    expect((props.amenities.items as Record<string, unknown>).enum).toBeUndefined();
  });
});

describe("runtimeSchemaToJsonSchema with constraints", () => {
  const constrainedSchema: RuntimeSchema = {
    id: "Constrained",
    description: "A constrained schema.",
    fields: [
      {
        name: "name",
        description: "Listing name",
        type: { kind: "string" },
        required: true,
        constraints: { maxLength: 40, minLength: 3, pattern: "^[A-Z]" },
      },
      {
        name: "sleeps",
        description: "Guest count",
        type: { kind: "number" },
        required: true,
        constraints: { minimum: 1, maximum: 20 },
      },
      {
        name: "interests",
        description: "Special interests",
        type: { kind: "array", items: { kind: "string" } },
        required: true,
        constraints: { maxItems: 5, maxLength: 30 },
      },
    ],
  };

  it("omits constraints under the openai-strict dialect, which is the default", () => {
    for (const result of [
      runtimeSchemaToJsonSchema(constrainedSchema),
      runtimeSchemaToJsonSchema(constrainedSchema, undefined, {
        dialect: "openai-strict",
      }),
    ]) {
      const props = result.properties as Record<string, Record<string, unknown>>;
      expect(props.name.maxLength).toBeUndefined();
      expect(props.name.pattern).toBeUndefined();
      expect(props.sleeps.minimum).toBeUndefined();
      expect(props.interests.maxItems).toBeUndefined();
      // The description still carries, so nothing else regressed.
      expect(props.name.description).toBe("Listing name");
    }
  });

  it("emits constraints under the standard dialect", () => {
    const result = runtimeSchemaToJsonSchema(constrainedSchema, undefined, {
      dialect: "standard",
    });
    const props = result.properties as Record<string, Record<string, unknown>>;

    expect(props.name).toMatchObject({ maxLength: 40, minLength: 3, pattern: "^[A-Z]" });
    expect(props.sleeps).toMatchObject({ minimum: 1, maximum: 20 });
  });

  it("puts item bounds on items and array bounds on the array", () => {
    const result = runtimeSchemaToJsonSchema(constrainedSchema, undefined, {
      dialect: "standard",
    });
    const props = result.properties as Record<string, Record<string, unknown>>;

    expect(props.interests.maxItems).toBe(5);
    expect(props.interests.maxLength).toBeUndefined();
    expect(props.interests.items).toMatchObject({ type: "string", maxLength: 30 });
  });

  const optionalConstrained: RuntimeSchema = {
    id: "Optional",
    description: "Optional constrained field.",
    fields: [
      {
        name: "description",
        description: "Long text",
        type: { kind: "string" },
        required: false,
        constraints: { maxLength: 1000 },
      },
    ],
  };

  it("keeps constraints on an optional field in the standard dialect", () => {
    const result = runtimeSchemaToJsonSchema(optionalConstrained, undefined, {
      dialect: "standard",
    });
    const props = result.properties as Record<string, Record<string, unknown>>;

    // Standard dialect leaves an optional field absent from `required` rather
    // than nullable, so the constraint sits directly on the property.
    expect(props.description.anyOf).toBeUndefined();
    expect(props.description.maxLength).toBe(1000);
    expect(result.required).toEqual([]);
  });

  it("drops constraints on an optional field under openai-strict", () => {
    const result = runtimeSchemaToJsonSchema(optionalConstrained);
    const props = result.properties as Record<string, Record<string, unknown>>;
    const branch = (props.description.anyOf as Record<string, unknown>[])[0];

    // Strict mode rejects unsupported keywords outright, so the bound is left
    // to the prompt and the validator; the nullable shape still applies.
    expect(branch.maxLength).toBeUndefined();
    expect(branch.type).toBe("string");
    expect(result.required).toEqual(["description"]);
  });
});

describe("runtimeSchemaToJsonSchema with a cyclic bundle", () => {
  it("stops inlining instead of recursing forever", () => {
    const nodeSchema: RuntimeSchema = {
      id: "Node",
      description: "A self-referencing node.",
      fields: [
        { name: "label", description: "Label", type: { kind: "string" }, required: true },
        {
          name: "child",
          description: "Nested node",
          type: { kind: "object", nestedSchemaId: "Node" },
          required: false,
        },
      ],
    };

    const result = runtimeSchemaToJsonSchema(nodeSchema, {
      schemas: { Node: nodeSchema },
    });
    const props = result.properties as Record<string, Record<string, unknown>>;
    const child = (props.child.anyOf as Record<string, unknown>[])[0];

    // The root is already on the inlining path, so the cycle closes here as
    // an opaque object rather than expanding Node inside itself.
    expect(child).toEqual({
      type: "object",
      additionalProperties: false,
      description: "Nested node",
    });
    expect(props.label.type).toBe("string");
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

  it("passes resolved enums through but never emits constraints", () => {
    const schema: RuntimeSchema = {
      id: "Listing",
      description: "A listing.",
      fields: [
        {
          name: "propertyType",
          description: "Kind",
          type: { kind: "dynamicEnum", sourceId: "propertyTypes" },
          required: true,
          constraints: { maxLength: 40 },
        },
      ],
    };

    const result = toOpenAIJsonSchema(schema, undefined, {
      resolvedEnums: { propertyTypes: ["villa"] },
    });
    const props = (result.schema as Record<string, unknown>)
      .properties as Record<string, Record<string, unknown>>;

    expect(props.propertyType.enum).toEqual(["villa"]);
    expect(props.propertyType.maxLength).toBeUndefined();
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
