import { Schema, Describe } from "@sembl/core";

@Schema("The user's intent for generating a personalized outdoor activity prompt.")
export class PromptIntent {
  @Describe("The type of activity the user wants to do, e.g. cycling, running, hiking.")
  activity!: string;

  @Describe("Desired difficulty level: easy, moderate, or hard.")
  difficulty?: string;

  @Describe("Preferred duration in minutes.")
  duration?: number;

  @Describe("Any special requirements or preferences mentioned by the user.")
  notes?: string;
}
