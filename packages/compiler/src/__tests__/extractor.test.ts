import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { extractSchemas } from "../extractor/ast-extractor.js";

const fixturesDir = resolve(import.meta.dirname, "fixtures");

describe("extractSchemas", () => {
  it("extracts @Schema-decorated classes from fixture files", () => {
    const bundle = extractSchemas({
      filePatterns: [resolve(fixturesDir, "basic-schemas.ts")],
    });

    expect(Object.keys(bundle.schemas)).toHaveLength(2);
    expect(bundle.schemas["Address"]).toBeDefined();
    expect(bundle.schemas["Profile"]).toBeDefined();
  });

  it("extracts Address schema correctly", () => {
    const bundle = extractSchemas({
      filePatterns: [resolve(fixturesDir, "basic-schemas.ts")],
    });

    const address = bundle.schemas["Address"];
    expect(address.description).toBe(
      "A real-world location where a person usually starts outdoor activities.",
    );
    expect(address.fields).toHaveLength(3);

    const street = address.fields.find((f) => f.name === "street");
    expect(street).toBeDefined();
    expect(street!.description).toBe("Street number and street name.");
    expect(street!.type).toEqual({ kind: "string" });
    expect(street!.required).toBe(false);

    const city = address.fields.find((f) => f.name === "city");
    expect(city).toBeDefined();
    expect(city!.description).toBe("City or municipality.");
    expect(city!.type).toEqual({ kind: "string" });
    expect(city!.required).toBe(true);

    const zip = address.fields.find((f) => f.name === "zip");
    expect(zip).toBeDefined();
    expect(zip!.description).toBe("Postal code.");
    expect(zip!.required).toBe(false);
  });

  it("extracts Profile schema with nested types", () => {
    const bundle = extractSchemas({
      filePatterns: [resolve(fixturesDir, "basic-schemas.ts")],
    });

    const profile = bundle.schemas["Profile"];
    expect(profile.description).toBe(
      "User profile used to personalize outdoor routes.",
    );
    expect(profile.fields).toHaveLength(3);

    const activities = profile.fields.find((f) => f.name === "activities");
    expect(activities).toBeDefined();
    expect(activities!.type).toEqual({
      kind: "array",
      items: { kind: "string" },
    });
    expect(activities!.required).toBe(false);

    const address = profile.fields.find((f) => f.name === "address");
    expect(address).toBeDefined();
    expect(address!.type).toEqual({
      kind: "object",
      nestedSchemaId: "Address",
    });

    const experience = profile.fields.find((f) => f.name === "experience");
    expect(experience).toBeDefined();
    expect(experience!.type).toEqual({ kind: "string" });
  });

  it("returns empty bundle for files with no @Schema classes", () => {
    const bundle = extractSchemas({
      filePatterns: [resolve(fixturesDir, "no-schemas.ts")],
    });

    expect(Object.keys(bundle.schemas)).toHaveLength(0);
  });
});
