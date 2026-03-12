import { Schema, Describe } from "@sembl/core";
import type { Address } from "./address.js";

@Schema("User profile used to personalize outdoor routes.")
export class Profile {
  @Describe("Activities the user enjoys such as cycling, running, or walking.")
  activities?: string[];

  @Describe("The user's usual starting point for activities.")
  address?: Address;

  @Describe("The user's experience level.")
  experience?: string;
}
