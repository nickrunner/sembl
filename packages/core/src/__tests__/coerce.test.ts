import { describe, it, expect } from "vitest";
import { coerce, partialCoerce } from "../coerce/coerce.js";
import { CoerceError } from "../errors/coerce-error.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../provider/types.js";
import type { RuntimeSchema } from "../schema/types.js";

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
