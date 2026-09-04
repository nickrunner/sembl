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
