# @sembl/testing

Deterministic tests for code built on SEMBL, and a way to measure whether a
prompt or schema change helped.

```sh
pnpm add -D @sembl/testing
```

## Record and replay

```ts
import { replayOrRecord } from "@sembl/testing";
import { AnthropicProvider } from "@sembl/provider-anthropic";

const live = process.env.ANTHROPIC_API_KEY
  ? new AnthropicProvider({ model: "claude-sonnet-5", apiKey: process.env.ANTHROPIC_API_KEY })
  : undefined;

// Replays from ./recordings; records misses through `live` when it exists.
const provider = replayOrRecord("./recordings", live);
```

`RecordingProvider(inner, dir)` writes every request/response pair to one
JSON file, named by schema id and a hash of what reached the model — the
system prompt, the user input and the JSON Schema. `ReplayProvider(dir)`
answers from those files and never touches the network; a request with no
recording throws `ReplayMissError`, which is what you want in CI: a miss
means a fixture or a description changed and nobody re-recorded.

Because the key covers everything the model sees, editing a field
description invalidates only the recordings it affects.

## Eval harness

Nobody can tell whether a description change helped or hurt without
measuring. Fixtures are `{ input, expected }` pairs in a directory:

```json
// evals/listing/sea-cabin.json
{
  "input": { "file": "sea-cabin.html", "label": "Airbnb listing" },
  "expected": { "name": "Sea Cabin", "sleeps": 6, "amenities": ["sauna", "hot tub"] }
}
```

A file may hold one fixture or an array; an input may be a string, a
labelled source, a list of sources, or `{ "file": … }` to read a sibling
file. Then either call the harness:

```ts
import { runEval, loadFixtures, formatReport } from "@sembl/testing";

const report = await runEval({
  fixtures: loadFixtures("./evals/listing"),
  schema: Listing,
  provider,
  mode: "partialCoerce",
  prices: { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3 },
});
console.log(formatReport(report));
```

or run it from the CLI with a config module that exports the schema and the
provider:

```js
// sembl.eval.mjs
export { Listing as schema } from "./dist/schemas.js";
export const provider = new AnthropicProvider({ model: "claude-sonnet-5", apiKey: process.env.ANTHROPIC_API_KEY });
export const prices = { inputPerMTok: 3, outputPerMTok: 15 };
export const coerceOptions = {
  onInvalidField: "clamp",
  maxInputChars: 40_000,
  instructions: ["Guest counts exclude infants."],
};
```

```sh
sembl eval --config sembl.eval.mjs --fixtures ./evals/listing --replay ./evals/listing/recordings
```

The report gives per-field precision and recall — a wrong value counts
against both, a missing one against recall, an unexpected one against
precision — plus token usage, cost when prices are given, and latency
percentiles. Every run is written to `<fixtures>/.sembl-eval/last-run.json`
(or `--out`) and the next run prints deltas against it, so a change shows up
as `R -20pt` on the field it broke. `--replay` records the first run and
replays it afterwards, which makes evals free and deterministic in CI;
`--min-recall` and `--min-precision` turn a regression into a failing exit
code. Arrays of primitives compare as sets, since the order amenities come
back in is not a fact about the listing.
