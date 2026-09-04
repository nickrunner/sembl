import { coerce } from "@sembl/core";
import { Listing } from "../support/listing-runtime.js";
import { ListingSchema } from "../generated/Listing.schema.js";
import { demoProvider, enumResolver, sample } from "../support/provider.js";
import { heading, note, show, ok } from "../support/print.js";

export const title = "defineSchema: the same schema with no decorators and no codegen";

export async function run(): Promise<void> {
  const { provider } = demoProvider();

  heading("A runtime-defined schema is a RuntimeSchema plus its bundle");
  show("Listing.fields.map(f => f.name)", Listing.fields.map((f) => f.name));
  show("Object.keys(Listing.bundle.schemas)", Object.keys(Listing.bundle.schemas));

  heading("It matches the compiled class exactly");
  const same = JSON.stringify({ id: Listing.id, description: Listing.description, fields: Listing.fields }) ===
    JSON.stringify(ListingSchema);
  if (same) ok("defineSchema output === sembl extract output for Listing");
  else throw new Error("runtime and compiled Listing differ");

  heading("Coerce with it — no bundle argument needed, and Infer<> gives the type");
  note("`Listing` the value is the schema; `Listing` the type is Infer<typeof Listing>.");
  const listing: Listing = await coerce<Listing>(sample("barn.txt"), {
    provider,
    schema: Listing,
    enumResolver,
  });
  show("Listing", listing);
}
