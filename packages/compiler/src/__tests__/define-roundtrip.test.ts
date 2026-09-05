import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { defineSchema, field } from "@sembl/core";
import type { RuntimeSchema } from "@sembl/core";
import { extractSchemas } from "../extractor/ast-extractor.js";

const fixturesDir = resolve(import.meta.dirname, "fixtures");

/** Just the RuntimeSchema part of a defined schema, for comparison. */
function plain(schema: RuntimeSchema): RuntimeSchema {
  return { id: schema.id, description: schema.description, fields: schema.fields };
}

/**
 * The decorated classes in the fixtures, restated with the runtime builder.
 * Both paths must emit identical RuntimeSchema output — a consumer switching
 * from one to the other should see no change in prompts or validation.
 */
const Address = defineSchema(
  "Address",
  "A real-world location where a person usually starts outdoor activities.",
  {
    street: field.string("Street number and street name.").optional(),
    city: field.string("City or municipality."),
    zip: field.string("Postal code.").optional(),
  },
);

const Profile = defineSchema("Profile", "User profile used to personalize outdoor routes.", {
  activities: field
    .string("Activities the user enjoys such as cycling, running, or walking.")
    .array()
    .optional(),
  address: field.object(Address, "The user's usual starting point for activities.").optional(),
  experience: field.string("The user's experience level.").optional(),
});

const Listing = defineSchema(
  "Listing",
  "A vacation rental listing being pre-filled from scraped input.",
  {
    name: field.string("Display name for the listing.", { maxLength: 40, minLength: 3 }),
    nightlyRate: field
      .number("Nightly rate in the listing's currency.", { minimum: 0, maximum: 10000 })
      .optional(),
    latitude: field.number("Latitude of the property.", { minimum: -90, maximum: 90 }).optional(),
    photos: field
      .string("Photos of the property.")
      .array({ minItems: 1, maxItems: 30 })
      .optional(),
    reference: field
      .string("Internal reference code.", { pattern: "^[A-Z]{2}-\\d{4}$" })
      .optional(),
    amenities: field.valuesFrom("amenities", "Amenities the property offers.").array(),
    propertyType: field.valuesFrom("property-types", "The property's primary type.").optional(),
    cancellationPolicy: field
      .valuesFrom("cancellation-policies", "Both bounded and drawn from a taxonomy.", {
        maxLength: 32,
      })
      .optional(),
    website: field.string("The listing's own web page.", { format: "url" }).optional(),
  },
);

describe("defineSchema round-trips the compiler fixtures", () => {
  it("matches the basic fixtures field for field", () => {
    const bundle = extractSchemas({
      filePatterns: [resolve(fixturesDir, "basic-schemas.ts")],
    });
    expect(plain(Address)).toEqual(bundle.schemas.Address);
    expect(plain(Profile)).toEqual(bundle.schemas.Profile);
  });

  it("matches the annotated Listing, constraints and enum sources included", () => {
    const bundle = extractSchemas({
      filePatterns: [resolve(fixturesDir, "annotated-schemas.ts")],
    });
    expect(plain(Listing)).toEqual(bundle.schemas.Listing);
  });

  it("carries the same nested schemas the compiler would bundle", () => {
    const bundle = extractSchemas({
      filePatterns: [resolve(fixturesDir, "basic-schemas.ts")],
    });
    expect(Profile.bundle.schemas.Address).toEqual(bundle.schemas.Address);
  });
});
