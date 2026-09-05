import { describe, it, expect } from "vitest";
import { validateFormat, describeFormat, formatToJsonSchema, FIELD_FORMATS } from "../schema/formats.js";
import { validateStrict } from "../coerce/validator.js";
import { buildPrompt } from "../coerce/prompt-builder.js";
import { runtimeSchemaToJsonSchema } from "../schema/json-schema.js";
import { defineSchema, field } from "../schema/define.js";
import type { RuntimeSchema } from "../schema/types.js";

describe("validateFormat", () => {
  const cases: Record<string, { ok: string[]; bad: string[] }> = {
    url: { ok: ["https://example.com/a?b=1", "http://x.io"], bad: ["example.com", "ftp://x", "not a url"] },
    email: { ok: ["ada@example.com"], bad: ["ada", "ada@", "Ada <ada@example.com>"] },
    date: { ok: ["2026-09-05", "2024-02-29"], bad: ["2026-13-01", "2023-02-29", "05/09/2026", "2026-9-5"] },
    datetime: { ok: ["2026-09-05T14:30:00Z", "2026-09-05T14:30+02:00", "2026-09-05 14:30:00"], bad: ["2026-09-05", "yesterday"] },
    "iso-country": { ok: ["US", "DE", "PT"], bad: ["USA", "us", "United States", "Un"] },
    "us-state": { ok: ["CA", "NY", "DC", "PR"], bad: ["California", "ca", "XX"] },
    "us-state-name": { ok: ["California", "District of Columbia"], bad: ["CA", "california", "Calif."] },
    currency: { ok: ["USD", "EUR", "GBP"], bad: ["$", "dollars", "usd", "XYZ"] },
  };

  for (const [format, { ok, bad }] of Object.entries(cases)) {
    it(`checks ${format}`, () => {
      for (const value of ok) expect(validateFormat(value, format as never), value).toBeUndefined();
      for (const value of bad) expect(validateFormat(value, format as never), value).toMatch(/^Expected/);
    });
  }

  it("has a prompt phrase and a schema mapping for every format", () => {
    for (const format of FIELD_FORMATS) {
      expect(describeFormat(format).length).toBeGreaterThan(10);
      expect(typeof formatToJsonSchema(format)).toBe("object");
    }
  });
});

describe("format constraints through the pipeline", () => {
  const schema: RuntimeSchema = {
    id: "Place",
    description: "A place.",
    fields: [
      { name: "country", description: "Country", type: { kind: "string" }, required: true, constraints: { format: "iso-country" } },
      { name: "site", description: "Site", type: { kind: "string" }, required: false, constraints: { format: "url", maxLength: 200 } },
      {
        name: "tags",
        description: "Tags",
        type: { kind: "array", items: { kind: "string" } },
        required: false,
        constraints: { format: "currency" },
      },
    ],
  };

  it("validates strings and array elements", () => {
    expect(validateStrict({ country: "US", site: "https://a.io", tags: ["USD"] }, schema)).toEqual([]);
    const issues = validateStrict({ country: "United States", site: "a.io", tags: ["USD", "$"] }, schema);
    expect(issues.map((i) => i.path)).toEqual(["country", "site", "tags[1]"]);
    expect(issues[0].message).toContain("ISO 3166-1");
  });

  it("states the format in the prompt", () => {
    const prompt = buildPrompt(schema);
    expect(prompt).toContain("Limits: an ISO 3166-1 alpha-2 country code (e.g. US, DE, PT), never a country name.");
    expect(prompt).toContain("an absolute http(s) URL; at most 200 characters");
  });

  it("emits JSON Schema format or pattern in the standard dialect only", () => {
    const standard = runtimeSchemaToJsonSchema(schema, undefined, { dialect: "standard" }) as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(standard.properties.country.pattern).toBe("^[A-Z]{2}$");
    expect(standard.properties.site.format).toBe("uri");
    expect((standard.properties.tags.items as Record<string, unknown>).pattern).toBe("^[A-Z]{3}$");

    const strict = runtimeSchemaToJsonSchema(schema, undefined, { dialect: "openai-strict" }) as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(strict.properties.country.pattern).toBeUndefined();
    expect(strict.properties.site.format).toBeUndefined();
  });

  it("is available from the runtime builder", () => {
    const Built = defineSchema("Built", "d", { when: field.string("When.", { format: "date" }) });
    expect(Built.fields[0].constraints).toEqual({ format: "date" });
  });
});
