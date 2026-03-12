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
});
