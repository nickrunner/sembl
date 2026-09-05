import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ContentBlock, Provider, ProviderRequest, ProviderResponse } from "@sembl/core";

/**
 * One block of a multimodal request as a recording keeps it: text as is,
 * an image or a document as its metadata and a hash of its bytes (or its
 * URL), never the bytes themselves — a recording should stay a small,
 * readable JSON file, and the hash is enough to recognise the request.
 */
export type RecordedBlock =
  | { type: "text"; text: string }
  | {
      type: "image" | "document";
      label?: string;
      mediaType?: string;
      /** SHA-256 of the bytes, for inline content. */
      sha256?: string;
      /** Size in bytes, for inline content given as bytes or base64. */
      bytes?: number;
      /** The URL, for content the provider fetches itself. */
      url?: string;
    };

/** What a recording holds: enough of the request to recognise it, and the answer. */
export interface Recording {
  /** Hash of the parts of the request that determine the answer. */
  key: string;
  schemaId: string;
  request: {
    systemPrompt: string;
    userInput: string;
    /** The blocks of a multimodal request, with binary content hashed. */
    content?: RecordedBlock[];
    jsonSchema: Record<string, unknown>;
    history?: ProviderRequest["history"];
  };
  response: ProviderResponse;
  recordedAt: string;
}

function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(typeof data === "string" ? Buffer.from(data, "base64") : data).digest("hex");
}

function byteLength(data: Uint8Array | string): number {
  return typeof data === "string" ? Buffer.from(data, "base64").length : data.byteLength;
}

/** Reduce a block to what a recording keeps of it. */
export function describeBlock(block: ContentBlock): RecordedBlock {
  if (block.type === "text") return { type: "text", text: block.text };
  const described: RecordedBlock = { type: block.type };
  if (block.label !== undefined) described.label = block.label;
  if ("url" in block.source) {
    described.url = block.source.url;
  } else {
    described.mediaType = block.source.mediaType;
    described.sha256 = sha256(block.source.data);
    described.bytes = byteLength(block.source.data);
  }
  return described;
}

/** JSON with sorted keys, so the same request always hashes the same. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

/**
 * The key a request records under. Only the parts that reach the model
 * count: the system prompt, the user input and the JSON Schema. The runtime
 * schema and bundle are already folded into those. A multimodal request
 * also keys on its blocks, with each image or document reduced to a hash of
 * its bytes or its URL, so two different photos under the same label are
 * two recordings.
 */
export function recordingKey(request: ProviderRequest): string {
  const material = stable({
    systemPrompt: request.systemPrompt,
    userInput: request.userInput,
    jsonSchema: request.jsonSchema,
    ...(request.content ? { content: request.content.map(describeBlock) } : {}),
    // A repair call shares everything above with the call it repairs.
    ...(request.history && request.history.length > 0 ? { history: request.history } : {}),
  });
  return createHash("sha256").update(material).digest("hex").slice(0, 24);
}

function slug(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 40) || "schema";
}

/** Where a recording for a request lives inside a directory. */
export function recordingPath(dir: string, request: ProviderRequest): string {
  return join(dir, `${slug(request.schema.id)}.${recordingKey(request)}.json`);
}

/** Thrown by {@link ReplayProvider} when no recording matches a request. */
export class ReplayMissError extends Error {
  constructor(
    public readonly key: string,
    public readonly dir: string,
    public readonly schemaId: string,
  ) {
    super(
      `No recording for a "${schemaId}" request (key ${key}) in ${dir}. ` +
        "Run once with a RecordingProvider, or pass a fallback provider to record misses.",
    );
    this.name = "ReplayMissError";
  }
}

/**
 * Calls another provider and writes every request/response pair to a
 * directory, one JSON file each, named by schema and request hash. Run your
 * extraction code through it once with real credentials; the files it leaves
 * behind let a {@link ReplayProvider} answer the same requests offline.
 *
 * A request is identified by what reaches the model, so editing a field
 * description or the input produces a new recording rather than a stale hit.
 */
export class RecordingProvider implements Provider {
  readonly supportsHistory: boolean;
  readonly supportsImages: boolean;
  readonly supportsDocuments: boolean;

  constructor(
    private readonly inner: Provider,
    private readonly dir: string,
  ) {
    this.supportsHistory = inner.supportsHistory === true;
    this.supportsImages = inner.supportsImages === true;
    this.supportsDocuments = inner.supportsDocuments === true;
    mkdirSync(dir, { recursive: true });
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const response = await this.inner.complete(request);
    const recording: Recording = {
      key: recordingKey(request),
      schemaId: request.schema.id,
      request: {
        systemPrompt: request.systemPrompt,
        userInput: request.userInput,
        ...(request.content ? { content: request.content.map(describeBlock) } : {}),
        jsonSchema: request.jsonSchema,
        ...(request.history ? { history: request.history } : {}),
      },
      response,
      recordedAt: new Date().toISOString(),
    };
    writeFileSync(recordingPath(this.dir, request), JSON.stringify(recording, null, 2) + "\n");
    return response;
  }
}

/** Options for {@link ReplayProvider}. */
export interface ReplayOptions {
  /**
   * Where to send a request no recording matches. The answer is recorded,
   * so the next run replays it. Without one, a miss throws
   * {@link ReplayMissError} — the right behaviour in CI, where a miss means
   * a fixture changed and nobody re-recorded.
   */
  fallback?: Provider;
}

/**
 * Answers requests from a directory of recordings, never touching the
 * network. Deterministic, free, and fast: the provider to put under tests of
 * your own extraction code.
 */
export class ReplayProvider implements Provider {
  private readonly recorder: RecordingProvider | undefined;
  /**
   * Follows the fallback when there is one. A strict replay claims support
   * so that a recorded multi-turn repair is asked for the same way it was
   * recorded; the recordings decide whether it is answered.
   */
  readonly supportsHistory: boolean;
  /** As `supportsHistory`: a recorded image request replays without a live provider. */
  readonly supportsImages: boolean;
  readonly supportsDocuments: boolean;

  constructor(
    private readonly dir: string,
    options: ReplayOptions = {},
  ) {
    this.recorder = options.fallback ? new RecordingProvider(options.fallback, dir) : undefined;
    this.supportsHistory = options.fallback ? options.fallback.supportsHistory === true : true;
    this.supportsImages = options.fallback ? options.fallback.supportsImages === true : true;
    this.supportsDocuments = options.fallback ? options.fallback.supportsDocuments === true : true;
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const path = recordingPath(this.dir, request);
    if (existsSync(path)) {
      const recording = JSON.parse(readFileSync(path, "utf8")) as Recording;
      return recording.response;
    }
    if (this.recorder) {
      return this.recorder.complete(request);
    }
    throw new ReplayMissError(recordingKey(request), this.dir, request.schema.id);
  }

  /** How many recordings the directory holds. */
  size(): number {
    if (!existsSync(this.dir)) return 0;
    return readdirSync(this.dir).filter((f) => f.endsWith(".json")).length;
  }
}

/**
 * The usual arrangement: replay from `dir`, and record misses through
 * `live` when it is given — say, only when an API key is present — so the
 * same test file works locally with credentials and in CI without them.
 */
export function replayOrRecord(dir: string, live?: Provider): Provider {
  return new ReplayProvider(dir, live ? { fallback: live } : {});
}
