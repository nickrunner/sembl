// Fixtures for types the frozen FieldType contract cannot express. Each one
// should warn; none of them should silently emit as a string.
import { Schema, Describe } from "@sembl/core";

/** Not decorated with @Schema, so a field pointing at it dangles. */
export class UndecoratedOwner {
  name!: string;
}

@Schema("A listing full of types the schema contract has no kind for.")
export class ExoticListing {
  @Describe("When the listing was first published.")
  publishedAt?: Date;

  @Describe("Per-partner booking URLs, keyed by partner slug.")
  bookingLinks?: Record<string, string>;

  @Describe("Per-partner booking URLs written as an index signature.")
  partnerLinks?: { [partner: string]: string };

  @Describe("Nightly rates keyed by date.")
  rateCalendar?: Map<string, number>;

  @Describe("A union mixing a string literal and a number literal.")
  mixedUnion?: "auto" | 5;

  @Describe("A union of a string and an object.")
  mixedShape?: string | UndecoratedOwner;

  @Describe("Points at a class that is not decorated with @Schema.")
  owner?: UndecoratedOwner;

  @Describe("An optional boolean, which is a union under the hood.")
  instantBook?: boolean;

  @Describe("A union of number literals, which widens to number.")
  maxGuests?: 2 | 4 | 6;
}
