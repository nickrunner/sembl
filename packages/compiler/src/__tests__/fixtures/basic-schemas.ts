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

@Schema("User profile used to personalize outdoor routes.")
export class Profile {
  @Describe("Activities the user enjoys such as cycling, running, or walking.")
  activities?: string[];

  @Describe("The user's usual starting point for activities.")
  address?: Address;

  @Describe("The user's experience level.")
  experience?: string;
}
