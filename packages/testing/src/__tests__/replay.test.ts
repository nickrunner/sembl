import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coerce } from "@sembl/core";
import type { Provider, ProviderRequest, RuntimeSchema } from "@sembl/core";
import { RecordingProvider, ReplayProvider, ReplayMissError, replayOrRecord, recordingKey } from "../replay.js";

const schema: RuntimeSchema = {
  id: "Person",
  description: "A person.",
  fields: [{ name: "name", description: "Name", type: { kind: "string" }, required: true }],
};

function countingProvider() {
  let calls = 0;
  const provider: Provider = {
    async complete(request) {
      calls += 1;
      const name = request.userInput.replace(/<\/?source[^>]*>/g, "").trim();
      return { data: { name }, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    },
  };
  return { provider, calls: () => calls };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sembl-replay-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("recordingKey", () => {
  const base: ProviderRequest = {
    systemPrompt: "sys",
    userInput: "in",
    jsonSchema: { b: 1, a: { d: 2, c: 3 } },
    schema,
  };

  it("ignores key order and the runtime schema objects", () => {
    const reordered: ProviderRequest = {
      ...base,
      jsonSchema: { a: { c: 3, d: 2 }, b: 1 },
      bundle: { schemas: { Person: schema } },
    };
    expect(recordingKey(reordered)).toBe(recordingKey(base));
  });

  it("changes when anything the model sees changes", () => {
    expect(recordingKey({ ...base, userInput: "other" })).not.toBe(recordingKey(base));
    expect(recordingKey({ ...base, systemPrompt: "other" })).not.toBe(recordingKey(base));
  });
});

describe("RecordingProvider and ReplayProvider", () => {
  it("records a call and replays it without touching the inner provider", async () => {
    const live = countingProvider();
    const recorder = new RecordingProvider(live.provider, dir);
    const first = await coerce<{ name: string }>("Ada", { provider: recorder, schema });
    expect(first).toEqual({ name: "Ada" });
    expect(readdirSync(dir)).toHaveLength(1);
    expect(readdirSync(dir)[0]).toMatch(/^Person\.[0-9a-f]{24}\.json$/);

    const replay = new ReplayProvider(dir);
    const second = await coerce<{ name: string }>("Ada", { provider: replay, schema });
    expect(second).toEqual({ name: "Ada" });
    expect(live.calls()).toBe(1);
    expect(replay.size()).toBe(1);
  });

  it("throws a ReplayMissError for an unrecorded request", async () => {
    const replay = new ReplayProvider(dir);
    await expect(coerce("Ada", { provider: replay, schema })).rejects.toThrow(ReplayMissError);
  });

  it("records misses through a fallback and replays them afterwards", async () => {
    const live = countingProvider();
    const provider = replayOrRecord(dir, live.provider);
    await coerce("Ada", { provider, schema });
    await coerce("Ada", { provider, schema });
    await coerce("Grace", { provider, schema });
    expect(live.calls()).toBe(2);
    expect(readdirSync(dir)).toHaveLength(2);
  });

  it("replays strictly when no live provider is given", async () => {
    const provider = replayOrRecord(dir);
    await expect(coerce("Ada", { provider, schema })).rejects.toThrow(ReplayMissError);
  });

  it("reports an empty directory as size zero", () => {
    expect(new ReplayProvider(join(dir, "missing")).size()).toBe(0);
  });
});
