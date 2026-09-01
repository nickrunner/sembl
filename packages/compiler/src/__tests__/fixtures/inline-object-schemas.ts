// Fixtures for anonymous inline object types, which the compiler synthesizes
// nested schemas for rather than pointing at an id nothing answers to.
import { Schema, Describe } from "@sembl/core";

@Schema("A stay whose sub-shapes are declared inline rather than as classes.")
export class StayDetails {
  @Describe("Points of interest near the property.")
  nearbyAttractions?: { description: string; distance: number }[];

  @Describe("Who to contact about the property.")
  contact?: { name: string; phone?: string };

  @Describe("Check-in and check-out windows.")
  checkTimes?: { checkIn: string; checkOut: string; flexible: boolean };

  @Describe("A shape identical to contact, at a different property.")
  emergencyContact?: { name: string; phone?: string };

  @Describe("Nested one level deeper.")
  host?: { name: string; address: { city: string; country: string } };
}

@Schema("A second class reusing the same inline property name.")
export class OtherStay {
  @Describe("Same property name, different owning class.")
  contact?: { email: string };
}
