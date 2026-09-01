import { describe, it, expect } from "vitest";
import { buildPrompt } from "../coerce/prompt-builder.js";
import type { RuntimeSchema, SchemaBundle } from "../schema/types.js";

const addressSchema: RuntimeSchema = {
  id: "Address",
  description: "A real-world location.",
  fields: [
    { name: "city", description: "City name", type: { kind: "string" }, required: true },
    { name: "zip", description: "Postal code", type: { kind: "string" }, required: false },
  ],
};

const profileSchema: RuntimeSchema = {
  id: "Profile",
  description: "User profile for outdoor routes.",
  fields: [
    {
      name: "address",
      description: "Starting point",
      type: { kind: "object", nestedSchemaId: "Address" },
      required: false,
    },
    {
      name: "experience",
      description: "Experience level",
      type: { kind: "string" },
      required: false,
    },
  ],
};

const bundle: SchemaBundle = {
  schemas: { Address: addressSchema, Profile: profileSchema },
};

describe("buildPrompt", () => {
  it("includes schema id and description", () => {
    const prompt = buildPrompt(addressSchema);
    expect(prompt).toContain("Target schema: Address");
    expect(prompt).toContain("A real-world location.");
  });

  it("includes field descriptions with required/optional", () => {
    const prompt = buildPrompt(addressSchema);
    expect(prompt).toContain("city (required): City name");
    expect(prompt).toContain("zip (optional): Postal code");
  });

  it("includes nested schema context", () => {
    const prompt = buildPrompt(profileSchema, bundle);
    expect(prompt).toContain("address (optional): Starting point");
    expect(prompt).toContain("[Address: A real-world location.]");
    expect(prompt).toContain("address.city (required): City name");
  });

  it("includes instructions", () => {
    const prompt = buildPrompt(addressSchema);
    expect(prompt).toContain("semantic coercion engine");
    expect(prompt).toContain("null for optional fields");
  });

  it("terminates on a cyclic bundle", () => {
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

    const prompt = buildPrompt(nodeSchema, { schemas: { Node: nodeSchema } });
    expect(prompt).toContain("child (optional): Nested node");
    // The cycle closes: the nested block is not expanded again.
    expect(prompt).not.toContain("child.label");
  });
});

describe("buildPrompt constraints", () => {
  const constrainedSchema: RuntimeSchema = {
    id: "Listing",
    description: "A rental listing.",
    fields: [
      {
        name: "name",
        description: "Listing name",
        type: { kind: "string" },
        required: true,
        constraints: { maxLength: 40 },
      },
      {
        name: "summary",
        description: "Short blurb",
        type: { kind: "string" },
        required: false,
        constraints: { minLength: 10, maxLength: 1000 },
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
        required: false,
        constraints: { maxItems: 5 },
      },
      {
        name: "slug",
        description: "URL slug",
        type: { kind: "string" },
        required: false,
        constraints: { pattern: "^[a-z-]+$" },
      },
    ],
  };

  it("renders limits as plain instruction text", () => {
    const prompt = buildPrompt(constrainedSchema);

    expect(prompt).toContain("at most 40 characters");
    expect(prompt).toContain("between 10 and 1000 characters");
    expect(prompt).toContain("between 1 and 20");
    expect(prompt).toContain("at most 5 entries");
    expect(prompt).toContain("matching the pattern /^[a-z-]+$/");
  });

  it("says nothing for unconstrained fields", () => {
    const prompt = buildPrompt(addressSchema);
    expect(prompt).not.toContain("Limits:");
  });

  it("tells the model to respect the limits", () => {
    expect(buildPrompt(constrainedSchema)).toContain("Respect every stated limit");
  });
});

describe("buildPrompt dynamic enums", () => {
  const listingSchema: RuntimeSchema = {
    id: "Listing",
    description: "A rental listing.",
    fields: [
      {
        name: "amenities",
        description: "Amenity slugs",
        type: { kind: "array", items: { kind: "dynamicEnum", sourceId: "amenities" } },
        required: false,
      },
    ],
  };

  const manyValues = Array.from({ length: 300 }, (_, i) => `amenity-slug-${i}`);

  it("points at the schema instead of restating the taxonomy", () => {
    const prompt = buildPrompt(listingSchema, undefined, {
      resolvedEnums: { amenities: manyValues },
    });

    expect(prompt).toContain('one of the 300 allowed "amenities" values');
    expect(prompt).toContain("never invent a value");
    // The values themselves stay in the JSON schema — duplicating several
    // hundred slugs here would roughly double the input tokens per call.
    expect(prompt).not.toContain("amenity-slug-0");
    expect(prompt).not.toContain("amenity-slug-299");
  });

  it("stays short regardless of taxonomy size", () => {
    const small = buildPrompt(listingSchema, undefined, {
      resolvedEnums: { amenities: ["wifi"] },
    });
    const large = buildPrompt(listingSchema, undefined, {
      resolvedEnums: { amenities: manyValues },
    });

    // Only the printed count differs.
    expect(large.length - small.length).toBeLessThan(10);
  });

  it("says nothing about values when the source is unresolved", () => {
    const prompt = buildPrompt(listingSchema);

    expect(prompt).toContain("amenities (optional): Amenity slugs");
    expect(prompt).not.toContain("allowed");
  });
});
