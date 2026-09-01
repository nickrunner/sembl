import { APIConnectionError, APIError } from "@anthropic-ai/sdk";

/**
 * Why a provider call failed, in the terms a caller can act on.
 *
 * A batch import wants to route these differently: `"api"` failures are worth
 * re-queueing, `"truncated"` needs a bigger output budget, and `"no_output"`
 * is a property of that one listing's content — retrying it changes nothing.
 *
 * The same three kinds are used by `@sembl/provider-openai`, so a caller that
 * branches on `kind` keeps working when the provider is swapped.
 */
export type ProviderErrorKind = "api" | "truncated" | "no_output";

/**
 * Error thrown by the Anthropic provider.
 *
 * Branch on `kind` rather than matching the message — messages stay
 * diagnostic and are free to change.
 */
export class AnthropicProviderError extends Error {
  /** What class of failure this is. */
  public readonly kind: ProviderErrorKind;
  /**
   * Whether another attempt could plausibly succeed. The SDK has already
   * retried retryable transport failures (see `maxRetries`); this says only
   * that the failure was transient in nature, so a caller running a queue can
   * re-enqueue the item rather than dead-letter it.
   */
  public readonly retryable: boolean;
  /** HTTP status, when the failure came back as an API error. */
  public readonly status?: number;
  /** Anthropic's `stop_reason`, when the call returned a message we rejected. */
  public readonly stopReason?: string;

  constructor(
    message: string,
    options: {
      kind: ProviderErrorKind;
      retryable: boolean;
      status?: number;
      stopReason?: string;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = "AnthropicProviderError";
    this.kind = options.kind;
    this.retryable = options.retryable;
    this.status = options.status;
    this.stopReason = options.stopReason;
  }
}

/**
 * Wrap an SDK-level failure as an `AnthropicProviderError`.
 *
 * Retryability is read off the SDK's own error classes rather than the
 * message: connection failures and timeouts are transient by construction,
 * and of the status codes only 408/409/429 and 5xx are worth another attempt —
 * the same set the SDK itself retries internally.
 */
export function toProviderError(error: unknown): AnthropicProviderError {
  if (error instanceof APIError) {
    const status = error.status;
    const retryable =
      error instanceof APIConnectionError ||
      status === undefined ||
      status === 408 ||
      status === 409 ||
      status === 429 ||
      status >= 500;

    return new AnthropicProviderError(
      `Anthropic request failed${status ? ` (${status})` : ""}: ${error.message}`,
      { kind: "api", retryable, status, cause: error },
    );
  }

  // Anything else (an AbortError, a bug in a caller-supplied client) is
  // surfaced with the same shape so callers only need one catch.
  return new AnthropicProviderError(
    `Anthropic request failed: ${error instanceof Error ? error.message : String(error)}`,
    { kind: "api", retryable: false, cause: error },
  );
}
