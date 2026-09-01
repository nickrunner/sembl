import { describe, it, expect } from "vitest";
import { coerce, partialCoerce } from "../coerce/coerce.js";
import { buildRepairInput } from "../coerce/repair.js";
import { CoerceError } from "../errors/coerce-error.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../provider/types.js";
import type { RuntimeSchema } from "../schema/types.js";
import type { TraceSink, TraceSpan } from "../tracing/types.js";

const listingSchema: RuntimeSchema = {
  id: "Listing",
  description: "A listing.",
  fields: [
    {
      name: "name",
      description: "Display name",
      type: { kind: "string" },
      required: true,
      constraints: { maxLength: 10 },
    },
    { name: "sleeps", description: "Guest count", type: { kind: "number" }, required: true },
  ],
};

/** Returns each scripted response in turn, recording the input it was asked with. */
function scriptedProvider(responses: Record<string, unknown>[]) {
  const inputs: string[] = [];
  const provider: Provider = {
    async complete(request: ProviderRequest): Promise<ProviderResponse> {
      inputs.push(request.userInput);
      const data = responses[Math.min(inputs.length - 1, responses.length - 1)];
      return { data };
    },
  };
  return { provider, inputs };
}

function collectSpans(): { sink: TraceSink; spans: TraceSpan[] } {
  const spans: TraceSpan[] = [];
  return { sink: { write: (span) => spans.push(span) }, spans };
}

describe("buildRepairInput", () => {
  it("carries the original input, the rejected output, and each issue", () => {
    const text = buildRepairInput("some listing text", { name: "far too long" }, [
      { path: "name", message: "Must be at most 10 characters", received: "far too long" },
    ]);

    expect(text).toContain("some listing text");
    expect(text).toContain('"name": "far too long"');
    expect(text).toContain("- name: Must be at most 10 characters");
    expect(text).toContain('received: "far too long"');
  });

  it("renders a missing value rather than the word undefined", () => {
    const text = buildRepairInput("in", {}, [
      { path: "sleeps", message: "Required field is missing", received: undefined },
    ]);

    expect(text).toContain("(missing)");
    expect(text).not.toContain("received: undefined");
  });

  it("truncates an oversized received value", () => {
    const text = buildRepairInput("in", {}, [
      { path: "name", message: "Too long", received: "x".repeat(500) },
    ]);

    expect(text).toContain("(truncated)");
    expect(text.length).toBeLessThan(900);
  });
});

describe("repair loop", () => {
  it("does not repair by default", async () => {
    const { provider, inputs } = scriptedProvider([{ name: "way too long a name", sleeps: 4 }]);

    await expect(
      coerce("listing text", { provider, schema: listingSchema }),
    ).rejects.toThrow(CoerceError);
    expect(inputs).toHaveLength(1);
  });

  it("retries with the issues and returns the corrected result", async () => {
    const { provider, inputs } = scriptedProvider([
      { name: "way too long a name", sleeps: 4 },
      { name: "Cabin", sleeps: 4 },
    ]);

    const result = await coerce<{ name: string }>("listing text", {
      provider,
      schema: listingSchema,
      maxRepairAttempts: 1,
    });

    expect(result.name).toBe("Cabin");
    expect(inputs).toHaveLength(2);
    // The retry carries the original input plus the correction context.
    expect(inputs[1]).toContain("listing text");
    expect(inputs[1]).toContain("way too long a name");
    expect(inputs[1]).toContain("name:");
  });

  it("gives up after the budget and throws the final issues", async () => {
    const { provider, inputs } = scriptedProvider([{ name: "still far too long", sleeps: 4 }]);

    await expect(
      coerce("listing text", { provider, schema: listingSchema, maxRepairAttempts: 2 }),
    ).rejects.toThrow(CoerceError);
    // One initial attempt plus two repairs.
    expect(inputs).toHaveLength(3);
  });

  it("does not spend a repair when the first attempt validates", async () => {
    const { provider, inputs } = scriptedProvider([{ name: "Cabin", sleeps: 4 }]);

    await coerce("listing text", {
      provider,
      schema: listingSchema,
      maxRepairAttempts: 3,
    });

    expect(inputs).toHaveLength(1);
  });

  it("repairs partial coercions too", async () => {
    const { provider, inputs } = scriptedProvider([
      { name: 42 },
      { name: "Cabin" },
    ]);

    const result = await partialCoerce<{ name: string }>("listing text", {
      provider,
      schema: listingSchema,
      maxRepairAttempts: 1,
    });

    expect(result.name).toBe("Cabin");
    expect(inputs).toHaveLength(2);
  });

  it("traces each attempt", async () => {
    const { provider } = scriptedProvider([
      { name: "way too long a name", sleeps: 4 },
      { name: "Cabin", sleeps: 4 },
    ]);
    const { sink, spans } = collectSpans();

    await coerce("listing text", {
      provider,
      schema: listingSchema,
      maxRepairAttempts: 1,
      traceSinks: [sink],
    });

    const llmSpans = spans.filter((s) => s.name === "llmCall");
    expect(llmSpans.map((s) => s.attributes?.attempt)).toEqual([0, 1]);

    const root = spans.find((s) => s.name === "coerce");
    const repair = root?.events.find((e) => e.name === "repairAttempt");
    expect(repair?.attributes).toMatchObject({ attempt: 1, issueCount: 1, paths: ["name"] });
  });

  it("rejects a nonsensical repair budget", async () => {
    const { provider } = scriptedProvider([{ name: "Cabin", sleeps: 4 }]);

    await expect(
      coerce("in", { provider, schema: listingSchema, maxRepairAttempts: -1 }),
    ).rejects.toThrow(RangeError);
    await expect(
      coerce("in", { provider, schema: listingSchema, maxRepairAttempts: 1.5 }),
    ).rejects.toThrow(RangeError);
  });
});
