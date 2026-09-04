import { partialCoerceWithProvenance, coerce, CoerceError } from "@sembl/core";
import type { Provider } from "@sembl/core";
import { Listing } from "../support/listing-runtime.js";
import { demoProvider, enumResolver, sample } from "../support/provider.js";
import { heading, note, show, ok } from "../support/print.js";

export const title = "onInvalidField: drop or clamp a bad field instead of failing the extraction";

/**
 * Takes the real model's answer and damages it on the way back, so the
 * policies have something to act on regardless of how well the model did.
 */
function tampering(inner: Provider): Provider {
  return {
    async complete(request) {
      const response = await inner.complete(request);
      const data = { ...response.data } as Record<string, unknown>;
      const wrap = (v: unknown) => (typeof data.name === "object" ? { ...(data.name as object), value: v } : v);
      data.name = wrap(`${String(unwrap(data.name))} — now with a much, much longer subtitle than any listing needs`);
      data.sleeps = typeof data.sleeps === "object" && data.sleeps ? { ...(data.sleeps as object), value: 200 } : 200;
      data.currency = typeof data.currency === "object" && data.currency ? { ...(data.currency as object), value: "dollars" } : "dollars";
      return { ...response, data };
    },
  };
}
function unwrap(v: unknown): unknown {
  return v && typeof v === "object" && "value" in v ? (v as { value: unknown }).value : v;
}

export async function run(): Promise<void> {
  const { provider } = demoProvider();
  const damaged = tampering(provider);
  note("The model's answer is deliberately damaged here: name over maxLength, sleeps = 200, currency = \"dollars\".");

  heading('Default ("throw"): one bad field fails everything');
  try {
    await coerce<Listing>(sample("sea-cabin.txt"), { provider: damaged, schema: Listing, enumResolver });
  } catch (error) {
    if (error instanceof CoerceError) show("CoerceError.issues", error.issues.map((i) => `${i.path}: ${i.message}`));
  }

  heading('"clamp": cut to the bound where that makes sense, drop otherwise');
  const clamped = await partialCoerceWithProvenance<Listing>(sample("sea-cabin.txt"), {
    provider: damaged,
    schema: Listing,
    enumResolver,
    onInvalidField: "clamp",
  });
  show("data", clamped.data);
  show("issues", clamped.issues.map((i) => `${i.path}: ${i.resolution}${i.replacement !== undefined ? ` → ${JSON.stringify(i.replacement)}` : ""}`));
  ok("name truncated, sleeps clamped to 30, currency dropped (a pattern has no clamp)");

  heading('"drop": remove the smallest thing that can go');
  const dropped = await partialCoerceWithProvenance<Listing>(sample("sea-cabin.txt"), {
    provider: damaged,
    schema: Listing,
    enumResolver,
    onInvalidField: "drop",
  });
  show("issues", dropped.issues.map((i) => `${i.path}: ${i.resolution}`));
  show("fields kept", Object.keys(dropped.data));
}
