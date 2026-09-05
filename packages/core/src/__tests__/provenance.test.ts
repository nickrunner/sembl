import { describe, it, expect } from "vitest";
import { coerceMany } from "../coerce/coerce-many.js";
import {
  coerceWithProvenance,
  partialCoerceWithProvenance,
} from "../coerce/coerce.js";
import { splitProvenance, toProvenanceSchema, provenanceInstructions } from "../coerce/provenance.js";
import { CoerceError } from "../errors/coerce-error.js";
import { runtimeSchemaToJsonSchema } from "../schema/json-schema.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../provider/types.js";
import type { RuntimeSchema, SchemaBundle } from "../schema/types.js";

const listingSchema: RuntimeSchema = {
  id: "Listing",
  description: "A listing.",
  fields: [
    {
      name: "name",
      description: "Display name",
      type: { kind: "string" },
      required: true,
      constraints: { maxLength: 40 },
    },
    { name: "sleeps", description: "Guest count", type: { kind: "number" }, required: false },
  ],
};

function scriptedProvider(responses: Record<string, unknown>[]) {
  const requests: ProviderRequest[] = [];
  const provider: Provider = {
    async complete(request: ProviderRequest): Promise<ProviderResponse> {
      requests.push(request);
      return { data: responses[Math.min(requests.length - 1, responses.length - 1)] };
    },
  };
  return { provider, requests };
}

describe("toProvenanceSchema", () => {
  it("wraps each field in value/confidence/evidence", () => {
    const { schema, bundle } = toProvenanceSchema(listingSchema);

    expect(schema.id).toBe("Listing__WithProvenance");
    expect(schema.fields.map((f) => f.name)).toEqual(["name", "sleeps"]);

    const annotation = bundle.schemas["Listing__name__Annotated"];
    expect(annotation.fields.map((f) => f.name)).toEqual(["value", "confidence", "evidence"]);
    expect(annotation.fields[1].type).toEqual({
      kind: "enum",
      values: ["high", "medium", "low"],
    });
    expect(annotation.fields[2].required).toBe(false);
  });

  it("carries the field's own type, description and constraints onto value", () => {
    const { bundle } = toProvenanceSchema(listingSchema);
    const value = bundle.schemas["Listing__name__Annotated"].fields[0];

    expect(value.type).toEqual({ kind: "string" });
    expect(value.description).toBe("Display name");
    expect(value.constraints).toEqual({ maxLength: 40 });
  });

  it("preserves whether the underlying field was required", () => {
    const { schema } = toProvenanceSchema(listingSchema);

    expect(schema.fields.find((f) => f.name === "name")?.required).toBe(true);
    expect(schema.fields.find((f) => f.name === "sleeps")?.required).toBe(false);
  });

  it("keeps the original bundle so nested types still inline", () => {
    const nested: RuntimeSchema = {
      id: "Address",
      description: "An address.",
      fields: [{ name: "city", description: "City", type: { kind: "string" }, required: true }],
    };
    const outer: RuntimeSchema = {
      id: "Host",
      description: "A host.",
      fields: [
        {
          name: "address",
          description: "Where they are",
          type: { kind: "object", nestedSchemaId: "Address" },
          required: true,
        },
      ],
    };
    const bundle: SchemaBundle = { schemas: { Address: nested, Host: outer } };

    const request = toProvenanceSchema(outer, bundle);
    const json = runtimeSchemaToJsonSchema(request.schema, request.bundle);
    const props = json.properties as Record<string, Record<string, unknown>>;
    const annotated = props.address.properties as Record<string, Record<string, unknown>>;
    const value = annotated.value.properties as Record<string, unknown>;

    expect(Object.keys(value)).toEqual(["city"]);
  });
});

describe("splitProvenance", () => {
  it("separates values from their annotations", () => {
    const { data, provenance } = splitProvenance(
      {
        name: { value: "Sea Cabin", confidence: "high", evidence: "the Sea Cabin sleeps 6" },
        sleeps: { value: 6, confidence: "medium" },
      },
      listingSchema,
    );

    expect(data).toEqual({ name: "Sea Cabin", sleeps: 6 });
    expect(provenance.name).toEqual({
      confidence: "high",
      evidence: "the Sea Cabin sleeps 6",
    });
    expect(provenance.sleeps).toEqual({ confidence: "medium" });
  });

  it("keeps the value when the annotation is unusable", () => {
    const { data, provenance } = splitProvenance(
      {
        name: { value: "Sea Cabin", confidence: "certain" },
        sleeps: 6,
      },
      listingSchema,
    );

    expect(data).toEqual({ name: "Sea Cabin", sleeps: 6 });
    expect(provenance.name).toBeUndefined();
    expect(provenance.sleeps).toBeUndefined();
  });

  it("drops empty evidence rather than reporting a blank quote", () => {
    const { provenance } = splitProvenance(
      { name: { value: "Cabin", confidence: "low", evidence: "" } },
      listingSchema,
    );

    expect(provenance.name).toEqual({ confidence: "low" });
  });

  it("passes a null field through as null", () => {
    const { data, provenance } = splitProvenance({ name: null, sleeps: null }, listingSchema);

    expect(data).toEqual({ name: null, sleeps: null });
    expect(provenance).toEqual({});
  });
});

describe("coerceWithProvenance", () => {
  it("returns data alongside per-field provenance", async () => {
    const { provider, requests } = scriptedProvider([
      {
        name: { value: "Sea Cabin", confidence: "high", evidence: "Sea Cabin" },
        sleeps: { value: 6, confidence: "low" },
      },
    ]);

    const { data, provenance } = await coerceWithProvenance<{
      name: string;
      sleeps: number;
    }>("Sea Cabin, sleeps about 6", { provider, schema: listingSchema });

    expect(data).toEqual({ name: "Sea Cabin", sleeps: 6 });
    expect(provenance.name.confidence).toBe("high");
    expect(provenance.sleeps.confidence).toBe("low");
    // The wrapper schema is what the provider was asked for.
    expect(requests[0].schema.id).toBe("Listing__WithProvenance");
    expect(requests[0].systemPrompt).toContain("Provenance:");
  });

  it("validates the unwrapped value against the original schema", async () => {
    const { provider } = scriptedProvider([
      { name: { value: 42, confidence: "high" }, sleeps: { value: 6, confidence: "high" } },
    ]);

    await expect(
      coerceWithProvenance("in", { provider, schema: listingSchema }),
    ).rejects.toThrow(CoerceError);
  });

  it("enforces constraints through the wrapper", async () => {
    const { provider } = scriptedProvider([
      { name: { value: "x".repeat(60), confidence: "high" } },
    ]);

    await expect(
      coerceWithProvenance("in", { provider, schema: listingSchema }),
    ).rejects.toThrow(/40/);
  });

  it("repairs a provenance run and keeps the annotations", async () => {
    const { provider, requests } = scriptedProvider([
      { name: { value: "x".repeat(60), confidence: "high" } },
      { name: { value: "Sea Cabin", confidence: "medium", evidence: "Sea Cabin" } },
    ]);

    const { data, provenance } = await coerceWithProvenance<{ name: string }>("in", {
      provider,
      schema: listingSchema,
      maxRepairAttempts: 1,
    });

    expect(data.name).toBe("Sea Cabin");
    expect(provenance.name.confidence).toBe("medium");
    // The repair feeds back the unwrapped value, which is what the issue named.
    expect(requests[1].userInput).toContain('"name"');
    expect(requests[1].userInput).not.toContain('"confidence"');
  });
});

describe("partialCoerceWithProvenance", () => {
  it("strips absent fields and reports provenance for what remains", async () => {
    const { provider } = scriptedProvider([
      { name: { value: "Sea Cabin", confidence: "high" }, sleeps: null },
    ]);

    const { data, provenance } = await partialCoerceWithProvenance<{
      name: string;
      sleeps: number;
    }>("Sea Cabin", { provider, schema: listingSchema });

    expect(data).toEqual({ name: "Sea Cabin" });
    expect("sleeps" in data).toBe(false);
    expect(Object.keys(provenance)).toEqual(["name"]);
  });
});

describe("per-field provenance", () => {
  const schema: RuntimeSchema = {
    id: "Listing",
    description: "A listing.",
    fields: [
      { name: "name", description: "Name", type: { kind: "string" }, required: true },
      { name: "sleeps", description: "Sleeps", type: { kind: "number" }, required: false },
      { name: "rate", description: "Rate", type: { kind: "number" }, required: false },
    ],
  };

  it("wraps only the listed fields", () => {
    const { schema: wrapper } = toProvenanceSchema(schema, undefined, { fields: ["name", "rate"] });
    expect(wrapper.fields.map((f) => `${f.name}:${f.type.kind}`)).toEqual([
      "name:object",
      "sleeps:number",
      "rate:object",
    ]);
  });

  it("tells the model which fields are wrapped", () => {
    const text = provenanceInstructions({ fields: ["name", "rate"] });
    expect(text).toContain("Only these fields are wrapped as objects, with the extracted value in `value`: name, rate.");
    expect(text).not.toContain("Every field is wrapped");
  });

  it("rejects a name that is not a field", () => {
    expect(() => toProvenanceSchema(schema, undefined, { fields: ["nope"] })).toThrow(RangeError);
  });

  it("splits a mixed response and reports provenance for the wrapped fields only", async () => {
    let request: ProviderRequest | undefined;
    const provider: Provider = {
      async complete(r) {
        request = r;
        return {
          data: { name: { value: "Cabin", confidence: "high", evidence: "Cabin" }, sleeps: 6, rate: { value: 250, confidence: "medium" } },
        };
      },
    };
    const result = await coerceWithProvenance<{ name: string; sleeps?: number; rate?: number }>("x", {
      provider,
      schema,
      provenanceFields: ["name", "rate"],
    });
    expect(request?.schema.fields.find((f) => f.name === "sleeps")?.type).toEqual({ kind: "number" });
    expect(result.data).toEqual({ name: "Cabin", sleeps: 6, rate: 250 });
    expect(Object.keys(result.provenance).sort()).toEqual(["name", "rate"]);
  });

  it("takes field names on coerceMany's provenance option", async () => {
    const provider: Provider = {
      async complete(r) {
        const wrapped = r.schema.fields.filter((f) => f.type.kind === "object").map((f) => f.name);
        return { data: { name: { value: "Cabin", confidence: "high" }, sleeps: 6, wrappedFields: wrapped } };
      },
    };
    const [result] = await coerceMany<{ name: string; sleeps?: number }>(["x"], {
      provider,
      schema,
      provenance: ["name"],
      onInvalidField: "drop",
    });
    expect(result.ok && result.provenance).toEqual({ name: { confidence: "high" } });
  });
});
