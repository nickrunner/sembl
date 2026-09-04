import type { CoerceOptions } from "./coerce.js";
import { runCoercion, stripNulls } from "./coerce.js";
import type { CoerceInput } from "./sources.js";
import type { FieldProvenance } from "./provenance.js";
import type { ResolvedIssue } from "./resolve-issues.js";

/** Options for {@link coerceMany}. Everything in `CoerceOptions` applies to each item. */
export interface CoerceManyOptions extends CoerceOptions {
  /** How many items may be in flight at once. Default 4. */
  concurrency?: number;
  /** Which coercion to run per item. Default `"coerce"`. */
  mode?: "coerce" | "partialCoerce";
  /** Ask for per-field provenance on every item. Default false. */
  provenance?: boolean;
  /**
   * Run the first item alone before fanning out, so a provider that caches
   * the prompt prefix writes it once and every later item reads it. Costs
   * one item's latency up front; saves a cache write per concurrent worker.
   * Default true.
   */
  primeCache?: boolean;
  /** How the batch backs off when the provider pushes back. */
  retry?: RetryOptions;
  /** Called as each item settles, in completion order, for progress. */
  onItem?: (result: CoerceManyResult<unknown>) => void;
  /** Stop starting new items; those not yet started fail with the reason. */
  signal?: AbortSignal;
}

/**
 * Backoff for provider errors that are worth another try — `kind: "api"`
 * with `retryable: true`, as both bundled providers report a 429, an
 * overloaded 529 or a dropped connection.
 *
 * The pause is shared: one rate-limit answer holds every worker, rather than
 * each item discovering the limit for itself and multiplying the pressure.
 * The delay doubles with each consecutive retryable failure across the batch
 * and resets on any success.
 */
export interface RetryOptions {
  /** Extra attempts per item after the first. Default 2. */
  attempts?: number;
  /** First pause, in milliseconds. Default 1000. */
  baseDelayMs?: number;
  /** Longest pause, in milliseconds. Default 30000. */
  maxDelayMs?: number;
}

/** One item's outcome. `index` is its position in the input list. */
export type CoerceManyResult<T> =
  | {
      ok: true;
      index: number;
      data: T;
      /** Per-field provenance when `provenance` was requested, else empty. */
      provenance: Record<string, FieldProvenance>;
      /** Issues the `onInvalidField` policy absorbed for this item. */
      issues: ResolvedIssue[];
      /** How many provider calls it took, repairs excluded. */
      attempts: number;
    }
  | {
      ok: false;
      index: number;
      error: unknown;
      attempts: number;
    };

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_RETRY: Required<RetryOptions> = {
  attempts: 2,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
};

/** Whether an error says the provider would plausibly accept another try. */
function isRetryable(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { kind, retryable } = error as { kind?: unknown; retryable?: unknown };
  return kind === "api" && retryable === true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The shared pause every worker honours before starting an attempt. */
class BackoffGate {
  private pausedUntil = 0;
  private streak = 0;

  constructor(private readonly retry: Required<RetryOptions>) {}

  async wait(): Promise<void> {
    const remaining = this.pausedUntil - Date.now();
    if (remaining > 0) await sleep(remaining);
  }

  /** Record a retryable failure and extend the pause for everyone. */
  failed(): void {
    this.streak += 1;
    const delay = Math.min(
      this.retry.maxDelayMs,
      this.retry.baseDelayMs * 2 ** (this.streak - 1),
    );
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + delay);
  }

  succeeded(): void {
    this.streak = 0;
  }
}

/**
 * Coerce many inputs against one schema.
 *
 * Runs at most `concurrency` items at a time, keeps results in input order,
 * and never rejects as a whole: each item settles to an `ok` or an error of
 * its own, so one bad listing cannot take down an import. Retryable provider
 * errors pause the whole batch and try the item again; anything else, a
 * `CoerceError` included, is that item's final answer.
 */
export async function coerceMany<T>(
  inputs: readonly CoerceInput[],
  options: CoerceManyOptions,
): Promise<CoerceManyResult<T>[]> {
  const {
    concurrency = DEFAULT_CONCURRENCY,
    mode = "coerce",
    provenance = false,
    primeCache = true,
    onItem,
    signal,
    ...coerceOptions
  } = options;
  const retry = { ...DEFAULT_RETRY, ...options.retry };

  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(`concurrency must be a positive integer, got ${String(concurrency)}`);
  }
  if (!Number.isInteger(retry.attempts) || retry.attempts < 0) {
    throw new RangeError(`retry.attempts must be a non-negative integer, got ${String(retry.attempts)}`);
  }

  const results: CoerceManyResult<T>[] = new Array(inputs.length);
  const gate = new BackoffGate(retry);

  async function runOne(index: number): Promise<void> {
    let attempts = 0;
    let result: CoerceManyResult<T>;

    for (;;) {
      if (signal?.aborted) {
        result = { ok: false, index, error: signal.reason ?? new Error("Batch aborted"), attempts };
        break;
      }
      await gate.wait();
      attempts += 1;
      try {
        const run = await runCoercion(inputs[index], coerceOptions, { mode, provenance });
        const data = (mode === "partialCoerce" ? stripNulls(run.data) : run.data) as T;
        gate.succeeded();
        result = { ok: true, index, data, provenance: run.provenance, issues: run.issues, attempts };
        break;
      } catch (error) {
        if (isRetryable(error) && attempts <= retry.attempts) {
          gate.failed();
          continue;
        }
        result = { ok: false, index, error, attempts };
        break;
      }
    }

    results[index] = result;
    onItem?.(result);
  }

  let next = 0;
  if (primeCache && inputs.length > 1) {
    await runOne(next++);
  }

  const workers = Array.from({ length: Math.min(concurrency, inputs.length) }, async () => {
    while (next < inputs.length) {
      await runOne(next++);
    }
  });
  await Promise.all(workers);

  return results;
}
