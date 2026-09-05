import type { CoerceOptions, PrimedPrefix, CoerceUsage } from "./coerce.js";
import { runCoercion, stripNulls, primeCache as warmPrefix, emptyUsage } from "./coerce.js";
import type { CoerceInput } from "./sources.js";
import { isSource } from "./sources.js";
import type { FieldProvenance } from "./provenance.js";
import type { ResolvedIssue } from "./resolve-issues.js";

/** What a batch accepts: an array, or anything that can be iterated, lazily or not. */
export type CoerceManyInputs = Iterable<CoerceInput> | AsyncIterable<CoerceInput>;

/** Options for {@link coerceMany}. Everything in `CoerceOptions` applies to each item. */
export interface CoerceManyOptions<T = unknown> extends CoerceOptions {
  /** How many items may be in flight at once. Default 4. */
  concurrency?: number;
  /** Which coercion to run per item. Default `"coerce"`. */
  mode?: "coerce" | "partialCoerce";
  /**
   * Ask for provenance on every item: `true` for every field, or the names
   * of the top-level fields to annotate. Default false.
   */
  provenance?: boolean | readonly string[];
  /**
   * How to warm a provider's prompt cache before fanning out, so the stable
   * prefix is written once and every item reads it.
   *
   * - `true` (default): run the first item alone, then fan out. No extra
   *   call, but the batch waits for one full item.
   * - `"eager"`: send a warm-up call the moment the batch starts and fan out
   *   as soon as it lands. One extra small call; no item waits on another.
   *   The right choice when inputs stream in from an async iterable.
   * - `false`: fan out immediately.
   *
   * Ignored when `primed` is given.
   */
  primeCache?: boolean | "eager";
  /**
   * A prefix already warmed with {@link primeCache}, or the promise of one.
   * Start it while fetching inputs and hand it over here: the batch waits
   * for it (not for an item) and then fans out. A warm-up that fails is
   * traced and otherwise ignored — the batch runs, only colder.
   */
  primed?: PrimedPrefix | Promise<PrimedPrefix>;
  /** How the batch backs off when the provider pushes back. */
  retry?: RetryOptions;
  /** Called as each item settles, in completion order, for progress. */
  onItem?: (result: CoerceManyResult<T>) => void;
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

/** One item's outcome. `index` is its position in the input sequence. */
export type CoerceManyResult<T> =
  | {
      ok: true;
      index: number;
      data: T;
      /** Per-field provenance when `provenance` was requested, else empty. */
      provenance: Record<string, FieldProvenance>;
      /** Issues the `onInvalidField` policy absorbed for this item. */
      issues: ResolvedIssue[];
      /** Token usage over every call this item made, repairs included. */
      usage: CoerceUsage;
      /** How many times the item was started, retries included. */
      attempts: number;
    }
  | {
      ok: false;
      index: number;
      error: unknown;
      /** Usage of the calls made before giving up. */
      usage: CoerceUsage;
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
 * Hands out inputs one at a time to however many workers ask, in order,
 * from a sync or async iterable. Pulls are serialised: an async iterator
 * must not have two `next()` calls in flight.
 */
class InputQueue {
  private readonly iterator: AsyncIterator<CoerceInput> | Iterator<CoerceInput>;
  private pulling: Promise<unknown> = Promise.resolve();
  private index = 0;

  constructor(inputs: CoerceManyInputs) {
    this.iterator =
      Symbol.asyncIterator in inputs
        ? (inputs as AsyncIterable<CoerceInput>)[Symbol.asyncIterator]()
        : (inputs as Iterable<CoerceInput>)[Symbol.iterator]();
  }

  next(): Promise<{ index: number; input: CoerceInput } | undefined> {
    const pull = this.pulling.then(async () => {
      const result = await this.iterator.next();
      if (result.done) return undefined;
      return { index: this.index++, input: result.value };
    });
    this.pulling = pull.catch(() => undefined);
    return pull;
  }
}

/** A label for trace spans: the first source's label, when it has one. */
function labelOf(input: CoerceInput): string | undefined {
  if (typeof input === "string") return undefined;
  if (isSource(input)) return input.label;
  return input[0]?.label;
}

/**
 * Coerce many inputs against one schema.
 *
 * Runs at most `concurrency` items at a time, keeps results in input order,
 * and never rejects as a whole: each item settles to an `ok` or an error of
 * its own, so one bad listing cannot take down an import. Retryable provider
 * errors pause the whole batch and try the item again; anything else, a
 * `CoerceError` included, is that item's final answer.
 *
 * Inputs may be an array or any iterable, including an async one, so a
 * batch can start while its inputs are still being fetched. Every span an
 * item emits carries `itemIndex` (and `itemLabel` when the input is
 * labelled), so a trace sink can attribute usage under concurrency.
 */
export async function coerceMany<T>(
  inputs: CoerceManyInputs,
  options: CoerceManyOptions<T>,
): Promise<CoerceManyResult<T>[]> {
  const {
    concurrency = DEFAULT_CONCURRENCY,
    mode = "coerce",
    provenance: provenanceOption = false,
    primeCache = true,
    primed,
    onItem,
    signal,
    retry: retryOptions,
    ...coerceOptions
  } = options;
  const retry = { ...DEFAULT_RETRY, ...retryOptions };
  const provenance = provenanceOption !== false;
  if (Array.isArray(provenanceOption)) {
    coerceOptions.provenanceFields = provenanceOption;
  }

  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(`concurrency must be a positive integer, got ${String(concurrency)}`);
  }
  if (!Number.isInteger(retry.attempts) || retry.attempts < 0) {
    throw new RangeError(`retry.attempts must be a non-negative integer, got ${String(retry.attempts)}`);
  }

  const results: CoerceManyResult<T>[] = [];
  const gate = new BackoffGate(retry);
  const queue = new InputQueue(inputs);

  async function runOne(index: number, input: CoerceInput): Promise<void> {
    let attempts = 0;
    let result: CoerceManyResult<T>;
    let usage = emptyUsage();
    const label = labelOf(input);
    const traceAttributes = { itemIndex: index, ...(label !== undefined ? { itemLabel: label } : {}) };

    for (;;) {
      if (signal?.aborted) {
        result = { ok: false, index, error: signal.reason ?? new Error("Batch aborted"), usage, attempts };
        break;
      }
      await gate.wait();
      attempts += 1;
      try {
        const run = await runCoercion(input, coerceOptions, { mode, provenance, traceAttributes });
        const data = (mode === "partialCoerce" ? stripNulls(run.data) : run.data) as T;
        gate.succeeded();
        result = { ok: true, index, data, provenance: run.provenance, issues: run.issues, usage: run.usage, attempts };
        break;
      } catch (error) {
        // Usage of a failed attempt is not recoverable from the error; the
        // trace still has it. Keep what the item accumulated so far.
        usage = emptyUsage();
        if (isRetryable(error) && attempts <= retry.attempts) {
          gate.failed();
          continue;
        }
        result = { ok: false, index, error, usage, attempts };
        break;
      }
    }

    results[index] = result;
    onItem?.(result);
  }

  // An input pulled ahead of the workers, handed to the first one to start.
  let pending: { index: number; input: CoerceInput } | undefined;

  // Warm the cache: with a warmed prefix (or an eager warm-up) nothing waits
  // on an item; with the default, the first item runs alone.
  const warmup = primed ?? (primeCache === "eager" ? warmPrefix({ ...coerceOptions, mode, provenance }) : undefined);
  if (warmup) {
    await Promise.resolve(warmup).catch(() => undefined);
  } else if (primeCache === true) {
    const first = await queue.next();
    if (first === undefined) return results;
    const second = await queue.next();
    if (second === undefined) {
      await runOne(first.index, first.input);
      return results;
    }
    await runOne(first.index, first.input);
    // The second item was pulled to learn whether priming was worth it; it
    // runs on the first worker below.
    pending = second;
  }

  const workers = Array.from({ length: concurrency }, async () => {
    for (;;) {
      const item = pending ?? (await queue.next());
      pending = undefined;
      if (item === undefined) return;
      await runOne(item.index, item.input);
    }
  });
  await Promise.all(workers);

  return results;
}
