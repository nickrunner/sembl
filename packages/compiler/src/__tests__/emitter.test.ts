import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SchemaBundle } from "@sembl/core";
import { emitSchemas } from "../generator/schema-emitter.js";

describe("emitSchemas", () => {
  let outputDir: string;

  beforeEach(() => {
    outputDir = mkdtempSync(join(tmpdir(), "sembl-test-"));
  });

  afterEach(() => {
    rmSync(outputDir, { recursive: true, force: true });
  });

  it("emits individual schema files and an index", () => {
    const bundle: SchemaBundle = {
      schemas: {
        Address: {
          id: "Address",
          description: "A location.",
          fields: [
            {
              name: "city",
              description: "City name.",
              type: { kind: "string" },
              required: true,
            },
          ],
        },
      },
    };

    const emitted = emitSchemas(bundle, outputDir);

    expect(emitted).toHaveLength(2); // Address.schema.ts + index.ts
    expect(existsSync(join(outputDir, "Address.schema.ts"))).toBe(true);
    expect(existsSync(join(outputDir, "index.ts"))).toBe(true);

    const schemaContent = readFileSync(
      join(outputDir, "Address.schema.ts"),
      "utf-8",
    );
    expect(schemaContent).toContain("AddressSchema");
    expect(schemaContent).toContain('"A location."');
    expect(schemaContent).toContain("RuntimeSchema");

    const indexContent = readFileSync(join(outputDir, "index.ts"), "utf-8");
    expect(indexContent).toContain("AddressSchema");
    expect(indexContent).toContain("SchemaBundle");
  });

  it("emits multiple schemas", () => {
    const bundle: SchemaBundle = {
      schemas: {
        Foo: {
          id: "Foo",
          description: "Foo schema.",
          fields: [],
        },
        Bar: {
          id: "Bar",
          description: "Bar schema.",
          fields: [],
        },
      },
    };

    const emitted = emitSchemas(bundle, outputDir);

    expect(emitted).toHaveLength(3); // Foo.schema.ts + Bar.schema.ts + index.ts
    expect(existsSync(join(outputDir, "Foo.schema.ts"))).toBe(true);
    expect(existsSync(join(outputDir, "Bar.schema.ts"))).toBe(true);
  });
});
