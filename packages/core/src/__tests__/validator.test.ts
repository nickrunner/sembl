import { describe, it, expect } from "vitest";
import { validateStrict, validatePartial } from "../coerce/validator.js";
import type { RuntimeSchema, SchemaBundle } from "../schema/types.js";

const addressSchema: RuntimeSchema = {
  id: "Address",
  description: "A location.",
  fields: [
    { name: "street", description: "Street", type: { kind: "string" }, required: false },
    { name: "city", description: "City", type: { kind: "string" }, required: true },
    { name: "zip", description: "Zip", type: { kind: "string" }, required: false },
  ],
};

const profileSchema: RuntimeSchema = {
  id: "Profile",
  description: "A profile.",
  fields: [
    {
      name: "activities",
      description: "Activities",
      type: { kind: "array", items: { kind: "string" } },
      required: false,
    },
    {
      name: "address",
      description: "Address",
      type: { kind: "object", nestedSchemaId: "Address" },
      required: false,
    },
    { name: "experience", description: "Experience", type: { kind: "string" }, required: false },
  ],
};

const bundle: SchemaBundle = {
  schemas: { Address: addressSchema, Profile: profileSchema },
};

describe("validateStrict", () => {
  it("passes for valid complete data", () => {
    const issues = validateStrict({ city: "Berlin", street: "Main St" }, addressSchema);
    expect(issues).toHaveLength(0);
  });

  it("fails for missing required field", () => {
    const issues = validateStrict({ street: "Main St" }, addressSchema);
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe("city");
    expect(issues[0].message).toContain("Required");
  });

  it("fails for wrong type", () => {
    const issues = validateStrict({ city: 123 }, addressSchema);
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe("city");
    expect(issues[0].message).toContain("string");
  });

  it("validates nested objects", () => {
    const issues = validateStrict(
      { address: { street: "Main St" } },
      profileSchema,
      bundle,
    );
    // Nested Address.city is required
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe("address.city");
  });

  it("validates arrays", () => {
    const issues = validateStrict(
      { activities: ["running", 42] },
      profileSchema,
      bundle,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe("activities[1]");
  });
});

describe("validatePartial", () => {
  it("passes for empty data", () => {
    const issues = validatePartial({}, addressSchema);
    expect(issues).toHaveLength(0);
  });

  it("passes for partial valid data", () => {
    const issues = validatePartial({ street: "Main St" }, addressSchema);
    expect(issues).toHaveLength(0);
  });

  it("still validates types of present fields", () => {
    const issues = validatePartial({ city: 42 }, addressSchema);
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe("city");
  });

  it("does not fail for missing required fields", () => {
    const issues = validatePartial({}, addressSchema);
    expect(issues).toHaveLength(0);
  });
});

describe("dynamic enum validation", () => {
  const listingSchema: RuntimeSchema = {
    id: "Listing",
    description: "A listing.",
    fields: [
      {
        name: "propertyType",
        description: "Kind",
        type: { kind: "dynamicEnum", sourceId: "propertyTypes" },
        required: true,
      },
      {
        name: "amenities",
        description: "Amenity slugs",
        type: { kind: "array", items: { kind: "dynamicEnum", sourceId: "amenities" } },
        required: false,
      },
    ],
  };

  const resolvedEnums = {
    propertyTypes: ["villa", "cabin"],
    amenities: ["wifi", "pool"],
  };

  it("accepts a resolved value", () => {
    const issues = validateStrict(
      { propertyType: "villa", amenities: ["wifi"] },
      listingSchema,
      undefined,
      { resolvedEnums },
    );
    expect(issues).toHaveLength(0);
  });

  it("rejects an invented slug and names the allowed values", () => {
    const issues = validateStrict({ propertyType: "chateau" }, listingSchema, undefined, {
      resolvedEnums,
    });

    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe("propertyType");
    expect(issues[0].message).toContain('"propertyTypes"');
    expect(issues[0].message).toContain("villa, cabin");
    expect(issues[0].message).toContain('"chateau"');
  });

  it("reports the offending index inside an array", () => {
    const issues = validatePartial(
      { amenities: ["wifi", "jacuzzi"] },
      listingSchema,
      undefined,
      { resolvedEnums },
    );

    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe("amenities[1]");
  });

  it("truncates a long allowed-value list in the message", () => {
    const many = Array.from({ length: 300 }, (_, i) => `slug-${i}`);
    const issues = validateStrict({ propertyType: "nope" }, listingSchema, undefined, {
      resolvedEnums: { propertyTypes: many },
    });

    expect(issues[0].message).toContain("(+290 more)");
    expect(issues[0].message).not.toContain("slug-299");
  });

  it("only type-checks a string when the source is unresolved", () => {
    // No resolvedEnums at all: any string is accepted.
    expect(validateStrict({ propertyType: "chateau" }, listingSchema)).toHaveLength(0);
    // A non-string is still an error.
    const issues = validateStrict({ propertyType: 42 }, listingSchema);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toBe("Expected string, got number");
  });

  it("treats a source resolved to an empty list as unresolved", () => {
    const issues = validateStrict({ propertyType: "chateau" }, listingSchema, undefined, {
      resolvedEnums: { propertyTypes: [] },
    });
    expect(issues).toHaveLength(0);
  });
});

describe("constraint validation", () => {
  const listingSchema: RuntimeSchema = {
    id: "Listing",
    description: "A listing.",
    fields: [
      {
        name: "name",
        description: "Name",
        type: { kind: "string" },
        required: true,
        constraints: { maxLength: 40, minLength: 3 },
      },
      {
        name: "sleeps",
        description: "Guests",
        type: { kind: "number" },
        required: false,
        constraints: { minimum: 1, maximum: 20 },
      },
      {
        name: "interests",
        description: "Special interests",
        type: { kind: "array", items: { kind: "string" } },
        required: false,
        constraints: { maxItems: 5, minItems: 1, maxLength: 12 },
      },
      {
        name: "slug",
        description: "Slug",
        type: { kind: "string" },
        required: false,
        constraints: { pattern: "^[a-z-]+$" },
      },
    ],
  };

  it("passes when every constraint is satisfied", () => {
    const issues = validateStrict(
      { name: "Casa Verde", sleeps: 4, interests: ["surfing"], slug: "casa-verde" },
      listingSchema,
    );
    expect(issues).toHaveLength(0);
  });

  it("names the limit and what was received for a too-long string", () => {
    const issues = validateStrict({ name: "x".repeat(57) }, listingSchema);

    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe("name");
    expect(issues[0].message).toBe("Expected at most 40 characters, got 57");
  });

  it("flags a too-short string", () => {
    const issues = validateStrict({ name: "ab" }, listingSchema);
    expect(issues[0].message).toBe("Expected at least 3 characters, got 2");
  });

  it("flags numbers outside their range", () => {
    expect(
      validateStrict({ name: "Casa", sleeps: 0 }, listingSchema)[0].message,
    ).toBe("Expected a value >= 1, got 0");
    expect(
      validateStrict({ name: "Casa", sleeps: 99 }, listingSchema)[0].message,
    ).toBe("Expected a value <= 20, got 99");
  });

  it("flags too many array entries", () => {
    const issues = validateStrict(
      { name: "Casa", interests: ["a", "b", "c", "d", "e", "f"] },
      listingSchema,
    );

    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe("interests");
    expect(issues[0].message).toBe("Expected at most 5 entries, got 6");
  });

  it("flags too few array entries", () => {
    const issues = validateStrict({ name: "Casa", interests: [] }, listingSchema);
    expect(issues[0].message).toBe("Expected at least 1 entry, got 0");
  });

  it("applies string bounds to each array element", () => {
    const issues = validateStrict(
      { name: "Casa", interests: ["surfing", "extremely-long-interest"] },
      listingSchema,
    );

    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe("interests[1]");
    expect(issues[0].message).toBe("Expected at most 12 characters, got 23");
  });

  it("flags a pattern mismatch", () => {
    const issues = validateStrict({ name: "Casa", slug: "Casa Verde" }, listingSchema);
    expect(issues[0].message).toBe(
      'Expected a value matching /^[a-z-]+$/, got "Casa Verde"',
    );
  });

  it("enforces constraints in partial mode too", () => {
    const issues = validatePartial({ name: "x".repeat(41) }, listingSchema);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toBe("Expected at most 40 characters, got 41");
  });

  it("reports a violation nested inside an array of objects", () => {
    const roomSchema: RuntimeSchema = {
      id: "Room",
      description: "A room.",
      fields: [
        {
          name: "label",
          description: "Room label",
          type: { kind: "string" },
          required: true,
          constraints: { maxLength: 5 },
        },
      ],
    };
    const propertySchema: RuntimeSchema = {
      id: "Property",
      description: "A property.",
      fields: [
        {
          name: "rooms",
          description: "Rooms",
          type: { kind: "array", items: { kind: "object", nestedSchemaId: "Room" } },
          required: true,
        },
      ],
    };
    const nestedBundle: SchemaBundle = {
      schemas: { Room: roomSchema, Property: propertySchema },
    };

    const issues = validateStrict(
      { rooms: [{ label: "den" }, { label: "master bedroom" }] },
      propertySchema,
      nestedBundle,
    );

    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe("rooms[1].label");
    expect(issues[0].message).toBe("Expected at most 5 characters, got 14");
  });

  it("reports a dynamic enum violation nested inside an array of objects", () => {
    const roomSchema: RuntimeSchema = {
      id: "Room",
      description: "A room.",
      fields: [
        {
          name: "kind",
          description: "Room kind",
          type: { kind: "dynamicEnum", sourceId: "roomKinds" },
          required: true,
        },
      ],
    };
    const propertySchema: RuntimeSchema = {
      id: "Property",
      description: "A property.",
      fields: [
        {
          name: "rooms",
          description: "Rooms",
          type: { kind: "array", items: { kind: "object", nestedSchemaId: "Room" } },
          required: true,
        },
      ],
    };

    const issues = validateStrict(
      { rooms: [{ kind: "bedroom" }, { kind: "dungeon" }] },
      propertySchema,
      { schemas: { Room: roomSchema, Property: propertySchema } },
      { resolvedEnums: { roomKinds: ["bedroom", "bathroom"] } },
    );

    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe("rooms[1].kind");
    expect(issues[0].received).toBe("dungeon");
  });
});
