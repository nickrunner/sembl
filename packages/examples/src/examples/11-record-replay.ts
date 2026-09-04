import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coerce } from "@sembl/core";
import type { Provider } from "@sembl/core";
import { RecordingProvider, ReplayProvider, ReplayMissError } from "@sembl/testing";
import { Listing } from "../support/listing-runtime.js";
import { demoProvider, enumResolver, sample } from "../support/provider.js";
import { heading, note, show, ok } from "../support/print.js";

export const title = "Record and replay: deterministic tests without an API key";

export async function run(): Promise<void> {
  const { provider } = demoProvider();
  const dir = mkdtempSync(join(tmpdir(), "sembl-demo-recordings-"));
  try {
    let liveCalls = 0;
    const counted: Provider = {
      async complete(request) {
        liveCalls += 1;
        return provider.complete(request);
      },
    };

    heading("Record once");
    const recorder = new RecordingProvider(counted, dir);
    const first = await coerce<Listing>(sample("city-flat.txt"), { provider: recorder, schema: Listing, enumResolver });
    show("recordings/", readdirSync(dir));
    note("File name = schema id + hash of what reached the model (system prompt, input, JSON Schema).");

    heading("Replay: the same request, zero live calls");
    const replay = new ReplayProvider(dir);
    const before = liveCalls;
    const second = await coerce<Listing>(sample("city-flat.txt"), { provider: replay, schema: Listing, enumResolver });
    ok(`live calls during replay: ${liveCalls - before}; identical result: ${JSON.stringify(first) === JSON.stringify(second)}`);

    heading("A changed input is a miss — loud, not silently stale");
    try {
      await coerce<Listing>(sample("barn.txt"), { provider: replay, schema: Listing, enumResolver });
    } catch (error) {
      if (error instanceof ReplayMissError) ok(`ReplayMissError: ${error.message.split(".")[0]}`);
      else throw error;
    }
    note("The whole example suite runs this way: see recordings/ after the first run.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
