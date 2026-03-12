import { describe, it, expect } from "vitest";
import { toResponseFormat } from "../schema-converter.js";
import type { RuntimeSchema } from "@sembl/core";

const testSchema: RuntimeSchema = {
  id: "TestSchema",
  description: "A test schema.",
  fields: [
    { name: "name", description: "Name field", type: { kind: "string" }, required: true },
    { name: "age", description: "Age field", type: { kind: "number" }, required: false },
  ],
};

describe("toResponseFormat", () => {
  it("produces a valid json_schema response format", () => {
    const result = toResponseFormat(testSchema);

    expect(result.type).toBe("json_schema");
    expect(result.json_schema.name).toBe("TestSchema");
    expect(result.json_schema.strict).toBe(true);

    const schema = result.json_schema.schema as Record<string, unknown>;
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
  });

  it("puts all fields in required array", () => {
    const result = toResponseFormat(testSchema);
    const schema = result.json_schema.schema as Record<string, unknown>;

    expect(schema.required).toEqual(["name", "age"]);
  });

  it("wraps optional fields with anyOf null", () => {
    const result = toResponseFormat(testSchema);
    const schema = result.json_schema.schema as Record<string, unknown>;
    const props = schema.properties as Record<string, Record<string, unknown>>;

    // age is optional, should have anyOf
    expect(props.age.anyOf).toEqual([
      { type: "number", description: "Age field" },
      { type: "null" },
    ]);

    // name is required, should not have anyOf
    expect(props.name.type).toBe("string");
    expect(props.name.anyOf).toBeUndefined();
  });
});
