import { coerce, partialCoerce, sembl, SemblConfig, SchemaRegistry, CoerceError } from "@sembl/core";
import type { Provider } from "@sembl/core";
import { bundle } from "../generated/index.js";
import { demoProvider } from "../support/provider.js";
import { heading, note, show, ok } from "../support/print.js";

export const title = "Basics: coerce, partialCoerce, errors, and the fluent chain";

interface Address {
  street?: string;
  city: string;
  zip?: string;
}
interface Profile {
  activities?: string[];
  address?: Address;
  experience?: string;
}
interface PromptIntent {
  activity: string;
  difficulty?: string;
  duration?: number;
  notes?: string;
}

export async function run(): Promise<void> {
  const { provider } = demoProvider();
  const registry = new SchemaRegistry();
  registry.registerBundle(bundle);
  SemblConfig.configure({ provider, bundle: registry.toBundle() });

  heading("coerce: every required field, or a CoerceError");
  note("Schemas here come from `sembl extract` over the decorated classes in src/schemas.");
  const address = await coerce<Address>("I'm staying at 12 Rue de Rivoli in Paris, 75001.", {
    provider,
    schema: registry.require("Address"),
  });
  show("Address", address);

  heading("partialCoerce: whatever the input supports, nulls stripped");
  const profile = await partialCoerce<Profile>(
    "Weekend cyclist, the occasional run. I head out from Berlin, 10115.",
    { provider, schema: registry.require("Profile"), bundle: registry.toBundle() },
  );
  show("Profile", profile);

  heading("A CoerceError carries per-field issues");
  note("Simulated with a stub provider so the failure is guaranteed; real models fail this way on messy input.");
  const stub: Provider = { async complete() { return { data: { city: 42 } }; } };
  try {
    await coerce<Address>("anything", { provider: stub, schema: registry.require("Address") });
  } catch (error) {
    if (error instanceof CoerceError) show("issues", error.issues);
  }

  heading("The fluent chain: narrow through intermediate shapes");
  const intent = await sembl(
    "I love cycling and running. I usually start from my place in Berlin, 10115. Feeling like an easy hour today.",
  )
    .partialCoerceTo<Profile>(registry.require("Profile"))
    .coerceTo<PromptIntent>(registry.require("PromptIntent"));
  show("PromptIntent (from a Profile, from a sentence)", intent);
  ok("two model calls, each with its own schema");
}
