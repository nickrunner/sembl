import { sembl, SemblConfig, SchemaRegistry } from "@sembl/core";
import { OpenAIProvider } from "@sembl/provider-openai";
import { bundle } from "./generated/index.js";

async function main() {
  const apiKey = process.env["OPENAI_API_KEY"];
  if (!apiKey) {
    console.error("Set OPENAI_API_KEY environment variable to run the demo.");
    process.exit(1);
  }

  const provider = new OpenAIProvider({
    model: "gpt-4o",
    apiKey,
  });

  const registry = new SchemaRegistry();
  registry.registerBundle(bundle);

  SemblConfig.configure({ provider, bundle: registry.toBundle() });

  const profileSchema = registry.require("Profile");
  const intentSchema = registry.require("PromptIntent");

  const conversation =
    "I love cycling and running. I usually start from my place in Berlin, 10115. I'd say I'm intermediate.";

  // Fluent chain: partialCoerce → coerce
  console.log("--- Fluent chain: partialCoerce → coerce ---");
  const intent = await sembl(conversation)
    .partialCoerceTo(profileSchema)
    .coerceTo(intentSchema);
  console.log("PromptIntent:", JSON.stringify(intent, null, 2));
}

main().catch(console.error);
