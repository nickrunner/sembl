import { describe, it, expect } from "vitest";
import { coerce, partialCoerce } from "../coerce/coerce.js";
import { CoerceError } from "../errors/coerce-error.js";
import { EnumResolutionError } from "../errors/enum-resolution-error.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../provider/types.js";
import type { RuntimeSchema } from "../schema/types.js";
import type { TraceSink, TraceSpan } from "../tracing/types.js";

const addressSchema: RuntimeSchema = {
  id: "Address",
  description: "A location.",
  fields: [
    { name: "street", description: "Street", type: { kind: "string" }, required: false },
    { name: "city", description: "City", type: { kind: "string" }, required: true },
    { name: "zip", description: "Zip", type: { kind: "string" }, required: false },
  ],
};

function createMockProvider(response: Record<string, unknown>): Provider {
  return {
    async complete(_request: ProviderRequest): Promise<ProviderResponse> {
      return {
        data: response,
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      };
    },
  };
}

describe("coerce", () => {
  it("returns data when validation passes", async () => {
    const provider = createMockProvider({ city: "Berlin", street: null, zip: null });

    const result = await coerce<{ city: string }>("I live in Berlin", {
      provider,
      schema: addressSchema,
    });

    expect(result.city).toBe("Berlin");
  });

  it("throws CoerceError when required field is missing", async () => {
    const provider = createMockProvider({ street: "Main St", city: null, zip: null });

    await expect(
      coerce("Main St somewhere", { provider, schema: addressSchema }),
    ).rejects.toThrow(CoerceError);
  });

  it("throws CoerceError with field issues", async () => {
    const provider = createMockProvider({ city: 123 });

    try {
      await coerce("test", { provider, schema: addressSchema });
      expect.fail("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CoerceError);
      const err = e as CoerceError;
      expect(err.issues.length).toBeGreaterThan(0);
      expect(err.issues[0].path).toBe("city");
    }
  });
});

describe("partialCoerce", () => {
  it("returns partial data, stripping nulls", async () => {
    const provider = createMockProvider({
      city: "Berlin",
      street: null,
      zip: null,
    });

    const result = await partialCoerce<{ city: string; street: string }>(
      "I live in Berlin",
      { provider, schema: addressSchema },
    );

    expect(result.city).toBe("Berlin");
    expect(result.street).toBeUndefined();
  });

  it("does not throw for missing required fields", async () => {
    const provider = createMockProvider({ street: "Main St", city: null, zip: null });

    const result = await partialCoerce("somewhere", {
      provider,
      schema: addressSchema,
    });

    expect(result).toEqual({ street: "Main St" });
  });

  it("still throws for type mismatches on present fields", async () => {
    const provider = createMockProvider({ city: 42 });

    await expect(
      partialCoerce("test", { provider, schema: addressSchema }),
    ).rejects.toThrow(CoerceError);
  });
});

const listingSchema: RuntimeSchema = {
  id: "Listing",
  description: "A rental listing.",
  fields: [
    {
      name: "propertyType",
      description: "Kind of property",
      type: { kind: "dynamicEnum", sourceId: "propertyTypes" },
      required: true,
    },
    {
      name: "specialInterests",
      description: "Special interests",
      type: { kind: "array", items: { kind: "dynamicEnum", sourceId: "specialInterests" } },
      required: false,
    },
    {
      name: "name",
      description: "Listing name",
      type: { kind: "string" },
      required: true,
      constraints: { maxLength: 40 },
    },
  ],
};

/** Provider that also captures the request it was handed. */
function createCapturingProvider(response: Record<string, unknown>): {
  provider: Provider;
  request(): ProviderRequest;
} {
  let captured: ProviderRequest | undefined;
  return {
    provider: {
      async complete(request: ProviderRequest): Promise<ProviderResponse> {
        captured = request;
        return { data: response };
      },
    },
    request: () => captured!,
  };
}

describe("enum resolution in coerce", () => {
  const enumResolver = (sourceId: string) =>
    sourceId === "propertyTypes" ? ["villa", "cabin"] : ["surfing", "yoga"];

  it("passes resolved enums to the prompt, schema, provider and validator", async () => {
    const { provider, request } = createCapturingProvider({
      propertyType: "villa",
      name: "Casa Verde",
      specialInterests: ["surfing"],
    });

    await coerce("a villa", { provider, schema: listingSchema, enumResolver });

    const req = request();
    expect(req.resolvedEnums).toEqual({
      propertyTypes: ["villa", "cabin"],
      specialInterests: ["surfing", "yoga"],
    });

    const props = req.jsonSchema.properties as Record<string, Record<string, unknown>>;
    expect(props.propertyType.enum).toEqual(["villa", "cabin"]);
    expect(req.systemPrompt).toContain('one of the 2 allowed "propertyTypes" values');
  });

  it("rejects a slug the model invented outside the taxonomy", async () => {
    const provider = createMockProvider({
      propertyType: "chateau",
      name: "Casa Verde",
      specialInterests: null,
    });

    await expect(
      coerce("a chateau", { provider, schema: listingSchema, enumResolver }),
    ).rejects.toThrow(/propertyTypes/);
  });

  it("accepts any string when no resolver is configured", async () => {
    const provider = createMockProvider({
      propertyType: "chateau",
      name: "Casa Verde",
      specialInterests: null,
    });

    const result = await coerce<{ propertyType: string }>("a chateau", {
      provider,
      schema: listingSchema,
    });

    expect(result.propertyType).toBe("chateau");
  });

  it("enforces constraints on the model's output", async () => {
    const provider = createMockProvider({
      propertyType: "villa",
      name: "x".repeat(41),
      specialInterests: null,
    });

    await expect(
      coerce("a villa", { provider, schema: listingSchema, enumResolver }),
    ).rejects.toThrow("Expected at most 40 characters, got 41");
  });

  it("throws EnumResolutionError when a required field's source throws", async () => {
    const provider = createMockProvider({ propertyType: "villa", name: "Casa" });

    const failing = (sourceId: string): string[] => {
      if (sourceId === "propertyTypes") {
        throw new Error("CMS unreachable");
      }
      return ["surfing"];
    };

    for (const call of [coerce, partialCoerce]) {
      await expect(
        call("a villa", { provider, schema: listingSchema, enumResolver: failing }),
      ).rejects.toThrow(EnumResolutionError);
    }
  });

  it("throws EnumResolutionError when a required field's source is empty", async () => {
    const provider = createMockProvider({ propertyType: "villa", name: "Casa" });

    await expect(
      coerce("a villa", {
        provider,
        schema: listingSchema,
        enumResolver: (id) => (id === "propertyTypes" ? [] : ["surfing"]),
      }),
    ).rejects.toThrow(EnumResolutionError);
  });

  it("widens to a free-form string when only an optional field's source fails", async () => {
    const provider = createMockProvider({
      propertyType: "villa",
      name: "Casa Verde",
      // specialInterests is optional and its source failed, so this passes.
      specialInterests: ["anything-goes"],
    });

    const result = await coerce<{ specialInterests: string[] }>("a villa", {
      provider,
      schema: listingSchema,
      enumResolver: (id) => {
        if (id === "specialInterests") {
          throw new Error("CMS unreachable");
        }
        return ["villa"];
      },
    });

    expect(result.specialInterests).toEqual(["anything-goes"]);
  });

  it("does not call the resolver when the schema has no dynamic enums", async () => {
    const provider = createMockProvider({ city: "Berlin" });
    let called = false;

    await coerce("Berlin", {
      provider,
      schema: addressSchema,
      enumResolver: () => {
        called = true;
        return ["x"];
      },
    });

    expect(called).toBe(false);
  });
});

describe("tracing", () => {
  function collectSpans(): { sinks: TraceSink[]; names: () => string[] } {
    const spans: TraceSpan[] = [];
    return {
      sinks: [{ write: (span) => spans.push(span) }],
      names: () => spans.map((s) => s.name),
    };
  }

  it("traces the same spans for coerce and partialCoerce", async () => {
    const expected = [
      "resolveEnums",
      "buildPrompt",
      "buildJsonSchema",
      "llmCall",
      "validate",
    ];

    for (const [call, root] of [
      [coerce, "coerce"],
      [partialCoerce, "partialCoerce"],
    ] as const) {
      const provider = createMockProvider({ propertyType: "villa", name: "Casa" });
      const { sinks, names } = collectSpans();

      await call("a villa", {
        provider,
        schema: listingSchema,
        enumResolver: () => ["villa"],
        traceSinks: sinks,
      });

      expect(names()).toEqual([...expected, root]);
    }
  });

  it("records each failed enum source as an event", async () => {
    const spans: TraceSpan[] = [];
    const provider = createMockProvider({ propertyType: "villa", name: "Casa" });

    await coerce("a villa", {
      provider,
      schema: listingSchema,
      enumResolver: (id) => (id === "propertyTypes" ? ["villa"] : []),
      traceSinks: [{ write: (span) => spans.push(span) }],
    });

    const resolveSpan = spans.find((s) => s.name === "resolveEnums")!;
    const failure = resolveSpan.events.find((e) => e.name === "enumSourceFailed")!;

    expect(failure.attributes).toMatchObject({
      sourceId: "specialInterests",
      reason: "empty",
      required: false,
    });
  });
});
