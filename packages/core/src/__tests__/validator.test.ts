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
