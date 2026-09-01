# @sembl/provider-anthropic

Anthropic provider for SEMBL. Structured output is obtained by declaring the
target schema as a single tool and forcing the model to call it, so arguments
come back parsed and shape-checked by the API.

## Install

```sh
pnpm add @sembl/core @sembl/provider-anthropic @anthropic-ai/sdk
```

`@anthropic-ai/sdk` is a peer dependency: the host app owns the version and,
usually, the client instance.

## Usage

```ts
import { sembl, SemblConfig } from "@sembl/core";
import { AnthropicProvider } from "@sembl/provider-anthropic";

SemblConfig.configure({
  provider: new AnthropicProvider({ model: "claude-sonnet-5", apiKey }),
  bundle,
});

const draft = await sembl(listingHtml).partialCoerceTo(StayDetailsSchema);
```

### Bring your own client

When the host app already resolves credentials its own way — Secret Manager,
Vault, Bedrock, Vertex — pass the client instead of an API key. Anything with a
compatible `messages.create` works, including `AnthropicBedrock` and
`AnthropicVertex`.

```ts
const provider = new AnthropicProvider({
  model: "claude-sonnet-5",
  client: await getAnthropic(), // your cached, secret-managed client
});
```

### Per-call model selection

`Provider` is cheap to construct and holds no connection state, so a service
that lets callers pick a model can build one per request over a shared client:

```ts
const provider = new AnthropicProvider({ model: req.model, client });
await coerce(input, { provider, schema, bundle });
```

## Options

| Option        | Default              | Notes                                                        |
| ------------- | -------------------- | ------------------------------------------------------------ |
| `model`       | —                    | Required.                                                     |
| `client`      | —                    | Pre-built SDK client. Takes precedence over `apiKey`/`baseURL`. |
| `apiKey`      | `ANTHROPIC_API_KEY`  | Falls back to the SDK's own env lookup.                       |
| `baseURL`     | Anthropic production | Ignored when `client` is set.                                 |
| `temperature` | `0`                  |                                                               |
| `maxTokens`   | `4096`               | Anthropic requires an explicit output budget.                 |
| `toolName`    | `extract_<SchemaId>` | Sanitized to Anthropic's `^[a-zA-Z0-9_-]{1,64}$`.             |

## Schema dialect

Anthropic takes ordinary JSON Schema, so this provider emits the `"standard"`
dialect: optional fields are omitted from `required` rather than being made
nullable the way OpenAI structured outputs demand. That keeps the model from
inventing explicit `null`s for fields the source never mentioned — which
matters for `partialCoerce`, where an absent field and a null field mean
different things to the caller.
