import { Schema, Describe, Constrain, ValuesFrom } from "@sembl/core";
import type { Address } from "./address.js";

@Schema("A short-term rental listing as a host would describe it.")
export class Listing {
  @Describe("Display name for the listing, as the host titled it.")
  @Constrain({ maxLength: 60 })
  name!: string;

  @Describe("How many guests can sleep there, counting sofa beds.")
  @Constrain({ minimum: 1, maximum: 30 })
  sleeps?: number;

  @Describe("Nightly rate as a plain number in the listing's own currency.")
  @Constrain({ minimum: 0 })
  nightlyRate?: number;

  @Describe("ISO 4217 code of the currency the rate is quoted in, e.g. USD, EUR, GBP.")
  @Constrain({ pattern: "^[A-Z]{3}$" })
  currency?: string;

  @Describe("Amenities the property offers.")
  @ValuesFrom("amenities")
  @Constrain({ maxItems: 8 })
  amenities?: string[];

  @Describe("The kind of property.")
  @ValuesFrom("property-types")
  propertyType?: string;

  @Describe("Whether guests may bring pets.")
  petsAllowed?: boolean;

  @Describe("Where the property is.")
  address?: Address;
}
