# @sembl/provider-openai

OpenAI provider for SEMBL. Structured output uses `response_format: json_schema`
in strict mode, so the model's reply is shape-checked by the API rather than
parsed out of prose.

## Install

```sh
pnpm add @sembl/core @sembl/provider-openai openai
```

`openai` is a peer dependency: the host app owns the version and, usually, the
client instance.

## Usage

```ts
import { sembl, SemblConfig } from "@sembl/core";
import { OpenAIProvider } from "@sembl/provider-openai";

SemblConfig.configure({
  provider: new OpenAIProvider({ model: "gpt-4o", apiKey }),
  bundle,
});
```

## Options

| Option        | Default              | Notes                                             |
| ------------- | -------------------- | ------------------------------------------------- |
| `model`       | —                    | Required.                                          |
| `apiKey`      | `OPENAI_API_KEY`     | Falls back to the SDK's own env lookup.            |
| `baseURL`     | OpenAI production    | Point at a gateway or compatible endpoint.         |
| `temperature` | not sent             | Sent only when set; reasoning models reject it.    |
| `maxTokens`   | SDK default          |                                                    |
| `maxRetries`  | SDK default (`2`)    | Retries are the SDK's own; this configures them.   |
| `timeoutMs`   | `120000`             | Per attempt. Worst case is roughly this × (`maxRetries` + 1), plus backoff. |

## Errors

Failures surface as `OpenAIProviderError` with a `kind` you can branch on
instead of matching message text:

| `kind`        | Meaning                                                        | `retryable` |
| ------------- | --------------------------------------------------------------- | ----------- |
| `api`         | Transport or API failure — rate limit, server error, timeout.    | per SDK     |
| `truncated`   | Output hit the token cap mid-answer (`finish_reason: "length"`). | no          |
| `no_output`   | A refusal, or content that wasn't usable JSON.                   | no          |

## Schema dialect

This provider emits the `"openai-strict"` dialect: every property appears in
`required` and optional fields become `anyOf: [T, null]`, as structured outputs
demand. `FieldConstraints` are deliberately **not** emitted into the schema —
strict mode rejects a request outright if it carries a keyword it doesn't
support, so bounds are enforced through the prompt and SEMBL's validator
instead. See `CONSTRAINT_KEYWORDS` in `@sembl/core` for what would need
verifying to loosen that.

## Caching

OpenAI caches long prompt prefixes automatically; there is nothing to turn on.
When it reports a hit, `usage.cacheReadTokens` carries it. Note that OpenAI
counts cached tokens *inside* `promptTokens` (Anthropic reports them
alongside), so don't add the two together.
