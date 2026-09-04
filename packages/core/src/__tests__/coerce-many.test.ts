import { describe, it, expect } from "vitest";
import { coerceMany } from "../coerce/coerce-many.js";
import { CoerceError } from "../errors/coerce-error.js";
import type { Provider, ProviderRequest } from "../provider/types.js";
import type { RuntimeSchema } from "../schema/types.js";

const schema: RuntimeSchema = {
  id: "Person",
  description: "A person.",
  fields: [
    { name: "name", description: "Name", type: { kind: "string" }, required: true },
    {
      name: "age",
      description: "Age",
      type: { kind: "number" },
      required: false,
      constraints: { maximum: 120 },
    },
  ],
};

/** Reads the name back out of the framed input. */
function nameOf(request: ProviderRequest): string {
  return request.userInput.replace(/<\/?source[^>]*>/g, "").trim();
}

class ApiError extends Error {
  kind = "api";
  constructor(public retryable: boolean) {
    super("api");
  }
}

/**
 * A provider that resolves when told to, so a test can hold calls open and
 * observe how many are in flight.
 */
function controllableProvider() {
  const pending: { name: string; resolve: () => void }[] = [];
  let inFlight = 0;
  let peak = 0;
  const provider: Provider = {
    complete(request) {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      return new Promise((resolve) => {
        pending.push({
          name: nameOf(request),
          resolve: () => {
            inFlight -= 1;
            resolve({ data: { name: nameOf(request) } });
          },
        });
      });
    },
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return {
    provider,
    pending,
    get peak() {
      return peak;
    },
    get inFlight() {
      return inFlight;
    },
    tick,
    async releaseAll() {
      while (pending.length > 0) {
        pending.shift()!.resolve();
        await tick();
      }
    },
  };
}

describe("coerceMany", () => {
  it("preserves input order and isolates failures", async () => {
    const provider: Provider = {
      async complete(request) {
        const name = nameOf(request);
        if (name === "bad") return { data: { name: 42 } };
        return { data: { name } };
      },
    };
    const results = await coerceMany<{ name: string }>(["a", "bad", "c"], {
      provider,
      schema,
      concurrency: 3,
      primeCache: false,
    });
    expect(results.map((r) => r.ok)).toEqual([true, false, true]);
    expect(results[0].ok && results[0].data).toEqual({ name: "a" });
    expect(results[2].ok && results[2].data).toEqual({ name: "c" });
    expect(!results[1].ok && results[1].error).toBeInstanceOf(CoerceError);
  });

  it("never has more than `concurrency` items in flight", async () => {
    const ctl = controllableProvider();
    const done = coerceMany(["a", "b", "c", "d", "e"], {
      provider: ctl.provider,
      schema,
      concurrency: 2,
      primeCache: false,
    });
    await ctl.tick();
    expect(ctl.inFlight).toBe(2);
    await ctl.releaseAll();
    await done;
    expect(ctl.peak).toBe(2);
  });

  it("runs the first item alone to prime the cache, then fans out", async () => {
    const ctl = controllableProvider();
    const done = coerceMany(["a", "b", "c", "d"], {
      provider: ctl.provider,
      schema,
      concurrency: 3,
    });
    await ctl.tick();
    expect(ctl.pending.map((p) => p.name)).toEqual(["a"]);
    ctl.pending.shift()!.resolve();
    await ctl.tick();
    expect(ctl.pending.map((p) => p.name).sort()).toEqual(["b", "c", "d"]);
    await ctl.releaseAll();
    const results = await done;
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("applies partial mode and the invalid-field policy per item", async () => {
    const provider: Provider = {
      async complete(request) {
        return { data: { name: nameOf(request), age: 500 } };
      },
    };
    const results = await coerceMany<Partial<{ name: string; age: number }>>(["a", "b"], {
      provider,
      schema,
      mode: "partialCoerce",
      onInvalidField: "clamp",
      primeCache: false,
    });
    expect(results[0].ok && results[0].data).toEqual({ name: "a", age: 120 });
    expect(results[1].ok && results[1].issues).toMatchObject([{ path: "age", resolution: "clamped" }]);
  });

  it("returns provenance when asked", async () => {
    const provider: Provider = {
      async complete(request) {
        return { data: { name: { value: nameOf(request), confidence: "high" } } };
      },
    };
    const [result] = await coerceMany<{ name: string }>(["a"], {
      provider,
      schema,
      provenance: true,
    });
    expect(result.ok && result.provenance).toEqual({ name: { confidence: "high" } });
  });

  it("retries retryable provider errors and pauses the whole batch", async () => {
    const starts: { name: string; at: number }[] = [];
    let failed = false;
    const provider: Provider = {
      async complete(request) {
        const name = nameOf(request);
        starts.push({ name, at: Date.now() });
        if (name === "a" && !failed) {
          failed = true;
          throw new ApiError(true);
        }
        return { data: { name } };
      },
    };
    const t0 = Date.now();
    const results = await coerceMany<{ name: string }>(["a", "b", "c"], {
      provider,
      schema,
      concurrency: 2,
      primeCache: false,
      retry: { attempts: 1, baseDelayMs: 40 },
    });
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results[0].attempts).toBe(2);
    // "a" and "b" start at once; "a" fails and pauses the gate. Both "a"'s
    // retry and "c"'s first call — on the other worker — wait it out.
    const retryOfA = starts.filter((s) => s.name === "a")[1];
    const firstC = starts.find((s) => s.name === "c")!;
    expect(retryOfA.at - t0).toBeGreaterThanOrEqual(35);
    expect(firstC.at - t0).toBeGreaterThanOrEqual(35);
  });

  it("gives up after the retry budget and reports attempts", async () => {
    const provider: Provider = {
      async complete() {
        throw new ApiError(true);
      },
    };
    const [result] = await coerceMany(["a"], {
      provider,
      schema,
      retry: { attempts: 2, baseDelayMs: 1 },
    });
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(3);
  });

  it("does not retry a non-retryable error", async () => {
    let calls = 0;
    const provider: Provider = {
      async complete() {
        calls += 1;
        throw new ApiError(false);
      },
    };
    const [result] = await coerceMany(["a"], { provider, schema, retry: { baseDelayMs: 1 } });
    expect(result.ok).toBe(false);
    expect(calls).toBe(1);
  });

  it("reports progress as items settle", async () => {
    const provider: Provider = {
      async complete(request) {
        return { data: { name: nameOf(request) } };
      },
    };
    const seen: number[] = [];
    await coerceMany(["a", "b", "c"], {
      provider,
      schema,
      onItem: (result) => seen.push(result.index),
    });
    expect(seen.sort()).toEqual([0, 1, 2]);
  });

  it("stops starting items once aborted", async () => {
    const controller = new AbortController();
    const provider: Provider = {
      async complete(request) {
        controller.abort(new Error("stop"));
        return { data: { name: nameOf(request) } };
      },
    };
    const results = await coerceMany(["a", "b", "c"], {
      provider,
      schema,
      concurrency: 1,
      primeCache: false,
      signal: controller.signal,
    });
    expect(results[0].ok).toBe(true);
    expect(results[1].ok).toBe(false);
    expect(!results[1].ok && (results[1].error as Error).message).toBe("stop");
    expect(results[2].ok).toBe(false);
  });

  it("rejects a bad concurrency", async () => {
    const provider: Provider = { async complete() { return { data: {} }; } };
    await expect(coerceMany(["a"], { provider, schema, concurrency: 0 })).rejects.toThrow(RangeError);
  });

  it("handles an empty batch", async () => {
    const provider: Provider = { async complete() { return { data: {} }; } };
    expect(await coerceMany([], { provider, schema })).toEqual([]);
  });
});
