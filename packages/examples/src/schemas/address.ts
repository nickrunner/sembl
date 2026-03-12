import { Schema, Describe } from "@sembl/core";

@Schema("A real-world location where a person usually starts outdoor activities.")
export class Address {
  @Describe("Street number and street name.")
  street?: string;

  @Describe("City or municipality.")
  city!: string;

  @Describe("Postal code.")
  zip?: string;
}
