// Fixtures for @Constrain and @ValuesFrom parsing, including the paths that
// should warn rather than emit something wrong.
import { Schema, Describe, Constrain, ValuesFrom } from "@sembl/core";
import type { FieldConstraints } from "@sembl/core";

const MAX_TITLE = 40;
const SHARED_BOUNDS: FieldConstraints = { maxLength: 120 };

@Schema("A vacation rental listing being pre-filled from scraped input.")
export class Listing {
  @Describe("Display name for the listing.")
  @Constrain({ maxLength: 40, minLength: 3 })
  name!: string;

  @Describe("Nightly rate in the listing's currency.")
  @Constrain({ minimum: 0, maximum: 10000 })
  nightlyRate?: number;

  @Describe("Latitude of the property.")
  @Constrain({ minimum: -90, maximum: 90 })
  latitude?: number;

  @Describe("Photos of the property.")
  @Constrain({ minItems: 1, maxItems: 30 })
  photos?: string[];

  @Describe("Internal reference code.")
  @Constrain({ pattern: "^[A-Z]{2}-\\d{4}$" })
  reference?: string;

  @Describe("Amenities the property offers.")
  @ValuesFrom("amenities")
  amenities!: string[];

  @Describe("The property's primary type.")
  @ValuesFrom("property-types")
  propertyType?: string;

  @Describe("Both bounded and drawn from a taxonomy.")
  @ValuesFrom("cancellation-policies")
  @Constrain({ maxLength: 32 })
  cancellationPolicy?: string;
}

@Schema("Listing fields whose annotations the compiler cannot resolve.")
export class UnreadableAnnotations {
  @Describe("Bound by a value the compiler never evaluates.")
  @Constrain({ maxLength: MAX_TITLE })
  fromVariable?: string;

  @Describe("Bound by a computed expression.")
  @Constrain({ maxLength: 20 * 2 })
  fromExpression?: string;

  @Describe("Bounds spread in from another object.")
  @Constrain({ ...SHARED_BOUNDS })
  fromSpread?: string;

  @Describe("The whole argument is a reference, not a literal.")
  @Constrain(SHARED_BOUNDS)
  wholeArgument?: string;

  @Describe("An unreadable bound alongside a readable one.")
  @Constrain({ maxLength: 40, minLength: MAX_TITLE })
  partiallyReadable?: string;

  @Describe("Bound by a key that is not in FieldConstraints.")
  // @ts-expect-error - not a FieldConstraints key; exercises the compiler warning
  @Constrain({ notAConstraint: 5 })
  unknownKey?: string;

  @Describe("Bound by a value of the wrong literal kind.")
  // @ts-expect-error - maxLength is a number; exercises the compiler warning
  @Constrain({ maxLength: "40" })
  wrongValueKind?: string;
}

@Schema("Fields where @ValuesFrom is on a type it cannot apply to.")
export class MisplacedValuesFrom {
  @Describe("A number cannot draw from an enum source.")
  @ValuesFrom("amenities")
  count?: number;

  @Describe("Nor can a nested object.")
  @ValuesFrom("amenities")
  nested?: Listing;

  @Describe("Nor can an array of objects.")
  @ValuesFrom("amenities")
  nestedList?: Listing[];

  @Describe("Nor can a compile-time enum.")
  @ValuesFrom("amenities")
  status?: "draft" | "published";
}
