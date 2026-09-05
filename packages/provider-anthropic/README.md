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

The provider declares `supportsImages` and `supportsDocuments`: an image
source becomes an `image` block and a PDF a `document` block in the user
message, inline as base64 or by URL for the API to fetch, each between the
same `<source>` tags that frame text.

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
| `temperature` | not sent             | Sent only when set. Newer models reject sampling parameters.  |
| `thinking`    | see note             | `{ type: "disabled" }` for Claude 5 models; unset otherwise.  |
| `requestOverrides` | —               | Merged into the request body last. For the next model-specific parameter. |
| `maxTokens`   | `4096`               | Anthropic requires an explicit output budget.                 |
| `toolName`    | `extract_<SchemaId>` | Sanitized to Anthropic's `^[a-zA-Z0-9_-]{1,64}$`.             |
| `cachePrompt` | `false`              | Cache the stable prefix — tool definition plus system prompt. |
| `cacheTtl`    | `"5m"`               | `"5m"` or `"1h"`. Ignored unless `cachePrompt` is set.        |
| `maxRetries`  | `2`                  | Retries per call, handled by the SDK.                         |
| `timeoutMs`   | `120000`             | Per-attempt timeout.                                          |

## Thinking and other model-specific parameters

Claude 5 models enable adaptive thinking by default, and the API rejects a
forced tool call while thinking is on. The provider therefore sends
`thinking: { type: "disabled" }` for any model id that names a Claude 5 model
(`claude-sonnet-5`, `claude-opus-5`, `claude-fable-5-1`, …) and nothing for
older models, which reject the parameter. Set `thinking` yourself to override
either way. When the next parameter of that kind appears, `requestOverrides`
lets you send it without waiting for a release:

```ts
new AnthropicProvider({
  model: "claude-sonnet-5",
  apiKey,
  requestOverrides: { metadata: { user_id: tenantId } },
});
```

## Prompt caching

Every call against the same schema sends the same tool definition and the same
system prompt; only the user input differs. `cachePrompt: true` marks that
prefix so the API processes it once and serves it from cache afterwards:

```ts
const provider = new AnthropicProvider({
  model: "claude-sonnet-5",
  apiKey,
  cachePrompt: true,
});
```

One breakpoint does the whole job. The API renders `tools` before `system`, so
marking the trailing system block covers the tool definition too, and the user
input — the only part that varies — sits after it in `messages`, where it
invalidates nothing.

**When it pays.** Cache reads cost about a tenth of an ordinary input token,
but a write costs about a quarter more than one. Two calls sharing a prefix
already break even on the 5-minute TTL; a single one-off call is slightly worse
off than leaving caching alone. Bulk imports — hundreds of listings through one
schema — are the case this exists for.

**When it does nothing.** A prefix shorter than the model's minimum cacheable
length is silently not cached (no error, no write): the minimum is
model-dependent and ranges from 512 to 4096 tokens, so a handful of fields with
short descriptions may never reach it. Caches are also scoped per model and per
workspace, so splitting a batch across models writes a separate entry for each.

**Choosing the TTL.** A read refreshes the entry, so with calls less than five
minutes apart the default `"5m"` stays warm indefinitely and is the cheaper
write. `"1h"` is for traffic with longer gaps — it survives them, but the write
costs roughly twice as much, so it needs three or so calls to pay for itself.

**Check that it is working.** `ProviderResponse.usage` reports it:

```ts
const { usage } = await provider.complete(request);
usage?.cacheWriteTokens; // prefix written to cache — expect this on call one
usage?.cacheReadTokens;  // prefix served from cache — expect this after that
```

A write on every call means something upstream is changing the prefix between
calls: a schema description built with a timestamp in it, non-deterministic
ordering of the enum values in a `dynamicEnum` field, a per-request tool name.
Note that Anthropic reports these *alongside* `promptTokens` rather than inside
it, so the prompt actually processed is the sum of the three.

## Resilience

Retries and timeouts are the SDK's, not a layer on top of it. It already
retries connection errors, 408, 409, 429 and 5xx with exponential backoff and
jitter, and honours `retry-after`. This provider only picks the numbers:
`maxRetries` (2, the SDK's own default) and `timeoutMs` (2 minutes, down from
the SDK's 10 — a long time for one listing to hold up an import queue).

Each retry gets its own timeout, so the worst-case wall clock for a call is
roughly `timeoutMs * (maxRetries + 1)` plus backoff. Size it accordingly.

When you supply your own `client`, that client's transport policy is left
alone unless you set `maxRetries` or `timeoutMs` explicitly — in which case
they are applied per call, overriding the client for SEMBL's requests only.

## Errors

Failures arrive as `AnthropicProviderError` with a `kind` you can branch on
instead of matching messages:

| `kind`        | Means                                          | `retryable` |
| ------------- | ---------------------------------------------- | ----------- |
| `"api"`       | Transport or API failure — rate limit, overload, timeout, bad request | `true` when transient |
| `"truncated"` | Output hit the token cap mid-tool-call         | `false`     |
| `"no_output"` | The model answered without calling the extraction tool | `false` |

```ts
try {
  await coerce(listingHtml, { provider, schema, bundle });
} catch (error) {
  if (error instanceof AnthropicProviderError && error.retryable) {
    return requeue(listing); // rate limited or overloaded
  }
  throw error;
}
```

`retryable` says the failure was transient in nature — the SDK has already
retried it `maxRetries` times, so this is about whether the item is worth
re-queueing rather than whether to loop immediately. The originating SDK error
is kept on `cause`, and `status` / `stopReason` carry the API's own account of
what happened. `@sembl/provider-openai` throws the same three `kind`s, so
caller code that branches on them survives a provider swap.

## Schema dialect

Anthropic takes ordinary JSON Schema, so this provider emits the `"standard"`
dialect: optional fields are omitted from `required` rather than being made
nullable the way OpenAI structured outputs demand. That keeps the model from
inventing explicit `null`s for fields the source never mentioned — which
matters for `partialCoerce`, where an absent field and a null field mean
different things to the caller.
