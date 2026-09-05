import { partialCoerce, EnumResolutionError, buildPrompt } from "@sembl/core";
import { bundle } from "../generated/index.js";
import { demoProvider, enumResolver, sample, taxonomy } from "../support/provider.js";
import { heading, note, show, ok, warn } from "../support/print.js";
import type { Listing } from "../support/listing-runtime.js";

export const title = "@Constrain and @ValuesFrom: bounds in the prompt, taxonomies resolved at runtime";

export async function run(): Promise<void> {
  const { provider } = demoProvider();
  const schema = bundle.schemas.Listing;

  heading("Constraints become prompt instructions and validation rules");
  note("currency carries format: \"currency\" — an ISO 4217 code, stated in the prompt and checked locally.");
  const prompt = buildPrompt(schema, bundle, { resolvedEnums: taxonomy });
  show("prompt excerpt", prompt.split("\n").filter((l) => l.includes("Limits:")).join("\n"));

  heading("@ValuesFrom sources resolve through your enumResolver");
  note(`amenities → ${taxonomy.amenities.join(", ")}`);
  const listing = await partialCoerce<Listing>(sample("lakehouse.txt"), {
    provider,
    schema,
    bundle,
    enumResolver,
  });
  show("Listing", listing);
  const offTaxonomy = (listing.amenities ?? []).filter((a) => !taxonomy.amenities.includes(a));
  if (offTaxonomy.length === 0) ok("every amenity is a taxonomy slug — the model never saw a free-form option");
  else warn(`off-taxonomy values slipped through: ${offTaxonomy.join(", ")}`);

  heading("A required field whose source fails to resolve throws, not widens");
  const required = {
    ...schema,
    fields: schema.fields.map((f) => (f.name === "propertyType" ? { ...f, required: true } : f)),
  };
  try {
    await partialCoerce(sample("lakehouse.txt"), {
      provider,
      schema: required,
      bundle,
      enumResolver: async (id) => {
        if (id === "property-types") throw new Error("CMS is down");
        return taxonomy[id];
      },
    });
  } catch (error) {
    if (error instanceof EnumResolutionError) {
      ok(`EnumResolutionError before any model call: ${error.message.split("\n")[0]}`);
    } else throw error;
  }
}
