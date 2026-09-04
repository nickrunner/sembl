import { readFileSync } from "node:fs";
import type { Provider, EnumResolver } from "@sembl/core";
import { AnthropicProvider } from "@sembl/provider-anthropic";
import { OpenAIProvider } from "@sembl/provider-openai";
import { ReplayProvider, replayOrRecord } from "@sembl/testing";
import { examplesPath, loadEnv } from "./env.js";

loadEnv();

/**
 * Which model the examples talk to. Anthropic when its key is present, with
 * prompt caching on since the batch examples benefit from it; OpenAI
 * otherwise. `SEMBL_MODEL` overrides the model id.
 */
export function liveProvider(): { provider: Provider; name: string } | undefined {
  const anthropicKey = process.env["ANTHROPIC_API_KEY"];
  if (anthropicKey) {
    const model = process.env["SEMBL_MODEL"] ?? "claude-sonnet-5";
    return {
      name: `Anthropic ${model}`,
      provider: new AnthropicProvider({ model, apiKey: anthropicKey, cachePrompt: true }),
    };
  }
  const openaiKey = process.env["OPENAI_API_KEY"];
  if (openaiKey) {
    const model = process.env["SEMBL_MODEL"] ?? "gpt-4o";
    return { name: `OpenAI ${model}`, provider: new OpenAIProvider({ model, apiKey: openaiKey }) };
  }
  return undefined;
}

export const recordingsDir = examplesPath("recordings");

/**
 * The provider every example uses: recordings under `recordings/` are
 * replayed, and anything not yet recorded goes to the live model and is
 * recorded on the way back. So the first run costs API calls and every run
 * after it is free and instant — until a prompt, schema or input changes,
 * at which point only the affected calls go live again.
 *
 * `SEMBL_LIVE=1` bypasses recordings entirely.
 */
export function demoProvider(): { provider: Provider; description: string } {
  const live = liveProvider();
  if (process.env["SEMBL_LIVE"] === "1") {
    if (!live) throw new Error("SEMBL_LIVE=1 needs ANTHROPIC_API_KEY or OPENAI_API_KEY");
    return { provider: live.provider, description: `${live.name}, live` };
  }
  const recorded = new ReplayProvider(recordingsDir).size();
  if (!live && recorded === 0) {
    throw new Error(
      "No API key and no recordings. Put ANTHROPIC_API_KEY or OPENAI_API_KEY in packages/examples/.env " +
        "(or the environment) for the first run; later runs replay from packages/examples/recordings.",
    );
  }
  return {
    provider: replayOrRecord(recordingsDir, live?.provider),
    description: live
      ? `${live.name}, recording misses to recordings/ (${recorded} recorded)`
      : `replaying ${recorded} recordings, no API key`,
  };
}

/**
 * A stand-in for the CMS taxonomy a real app would resolve `@ValuesFrom`
 * sources against. Slugs, not labels: this is what a database enum table or
 * a headless CMS actually hands back.
 */
export const taxonomy: Record<string, readonly string[]> = {
  amenities: ["wifi", "kitchen", "sauna", "hot-tub", "pool", "parking", "ev-charger", "kayaks", "balcony"],
  "property-types": ["house", "flat", "cabin", "barn", "villa", "lakehouse"],
};

export const enumResolver: EnumResolver = async (sourceId) => {
  const values = taxonomy[sourceId];
  if (!values) throw new Error(`Unknown taxonomy "${sourceId}"`);
  return values;
};

/** Read one of the sample inputs under `data/`. */
export function sample(name: string): string {
  return readFileSync(examplesPath("data", name), "utf8").trim();
}
