import { defineSchema, field } from "@sembl/core";
import type { Infer } from "@sembl/core";

/**
 * The same Listing as `src/schemas/listing.ts`, defined at runtime instead
 * of with decorators. `sembl extract` and `defineSchema` emit identical
 * RuntimeSchema output, so either can back any example.
 */
export const Address = defineSchema(
  "Address",
  "A real-world location where a person usually starts outdoor activities.",
  {
    street: field.string("Street number and street name.").optional(),
    city: field.string("City or municipality."),
    zip: field.string("Postal code.").optional(),
  },
);

export const Listing = defineSchema("Listing", "A short-term rental listing as a host would describe it.", {
  name: field.string("Display name for the listing, as the host titled it.", { maxLength: 60 }),
  sleeps: field.number("How many guests can sleep there, counting sofa beds.", { minimum: 1, maximum: 30 }).optional(),
  nightlyRate: field.number("Nightly rate as a plain number in the listing's own currency.", { minimum: 0 }).optional(),
  currency: field.string("The currency the rate is quoted in.", { format: "currency" }).optional(),
  amenities: field.valuesFrom("amenities", "Amenities the property offers.").array({ maxItems: 8 }).optional(),
  propertyType: field.valuesFrom("property-types", "The kind of property.").optional(),
  petsAllowed: field.boolean("Whether guests may bring pets.").optional(),
  address: field.object(Address, "Where the property is.").optional(),
});

export type Listing = Infer<typeof Listing>;
export type Address = Infer<typeof Address>;
