import type { ImageSource } from "@sembl/core";
import { ImageSourceError } from "./errors.js";
import { DEFAULT_MAX_BYTES, checkImageBytes, formatBytes } from "./image-source.js";

/** One image to download: a URL, or a URL with the alt text a page gave it. */
export type FetchImageItem = string | { url: string; alt?: string };

/** Why a URL produced no source. */
export type FetchImageSkipReason =
  /** The response status was not 2xx. */
  | "status"
  /** The response said it was not an image. */
  | "content_type"
  /** The bytes were not a format the providers accept. */
  | "unsupported"
  /** Over `maxBytes`, by header or by measure. */
  | "too_large"
  /** No response within `timeoutMs`. */
  | "timeout"
  /** The fetch itself failed — DNS, TLS, a dropped connection, a thrown error. */
  | "fetch"
  /** Fine, but `max` images were already taken. */
  | "count";

/** A URL that was not turned into a source, and why. */
export interface SkippedImage {
  url: string;
  reason: FetchImageSkipReason;
  /** The diagnostic. Free to change; branch on `reason`. */
  message: string;
  /** HTTP status, for `"status"`. */
  status?: number;
}

/** Options for {@link fetchImages}. */
export interface FetchImagesOptions {
  /** The fetch to use. Defaults to the global one; inject a fake in tests. */
  fetch?: typeof fetch;
  /** Most images to return, in input order. Default 10. Later URLs are not fetched. */
  max?: number;
  /** Refuse a download over this many bytes. Default {@link DEFAULT_MAX_BYTES}. */
  maxBytes?: number;
  /** Give up on one URL after this long. Default 15 000. */
  timeoutMs?: number;
  /** Downloads in flight at once. Default 4. */
  concurrency?: number;
  /**
   * The label for each source. Default: the item's alt text when it has
   * one, else `Image N` counted from 1 across the input.
   */
  label?: (item: FetchImageItem, index: number) => string;
  /** Headers sent with every request — a user agent, a referer the CDN wants. */
  headers?: Record<string, string>;
}

/** What {@link fetchImages} returns. */
export interface FetchedImages {
  /** The images that downloaded and checked out, in input order. */
  sources: ImageSource[];
  /** Every URL that did not, with the reason. */
  skipped: SkippedImage[];
}

type Outcome = { source: ImageSource } | { skip: Omit<SkippedImage, "url"> };

/**
 * Download the images a page shows — the list `@sembl/source-html`'s
 * `extractImages` harvests — into image sources.
 *
 * Every download is checked: the status, the `Content-Type` (which must
 * be an image or absent — a CDN's `application/octet-stream` is let
 * through to the sniff), the size (from the header first, then while the
 * body is read, so a lying header cannot force a huge download), and the
 * magic bytes, which decide the media type sent to the provider. A URL
 * that fails any of these is reported in `skipped`, never thrown; only
 * the URLs that pass become sources, in the page's order.
 *
 * `max` bounds the run: URLs beyond it are skipped as `"count"` without
 * being fetched, since a gallery can be a hundred images and a model
 * reads a handful.
 */
export async function fetchImages(items: readonly FetchImageItem[], options: FetchImagesOptions = {}): Promise<FetchedImages> {
  const {
    fetch: fetchImpl = globalThis.fetch,
    max = 10,
    maxBytes = DEFAULT_MAX_BYTES,
    timeoutMs = 15_000,
    concurrency = 4,
    label = defaultLabel,
    headers,
  } = options;
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImages needs a fetch: pass one in options.fetch");

  const outcomes: Outcome[] = new Array(items.length);
  const attempt = Math.min(items.length, Math.max(0, max));
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < attempt) {
      const index = next++;
      outcomes[index] = await fetchOne(items[index], { fetchImpl, maxBytes, timeoutMs, headers }, label(items[index], index));
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, attempt)) }, worker));

  const sources: ImageSource[] = [];
  const skipped: SkippedImage[] = [];
  items.forEach((item, index) => {
    const url = urlOf(item);
    if (index >= attempt) {
      skipped.push({ url, reason: "count", message: `Not fetched: max is ${max}` });
      return;
    }
    const outcome = outcomes[index];
    if ("source" in outcome) sources.push(outcome.source);
    else skipped.push({ url, ...outcome.skip });
  });
  return { sources, skipped };
}

function urlOf(item: FetchImageItem): string {
  return typeof item === "string" ? item : item.url;
}

function defaultLabel(item: FetchImageItem, index: number): string {
  const alt = typeof item === "string" ? undefined : item.alt?.trim();
  return alt ? alt : `Image ${index + 1}`;
}

async function fetchOne(
  item: FetchImageItem,
  options: { fetchImpl: typeof fetch; maxBytes: number; timeoutMs: number; headers?: Record<string, string> },
  label: string,
): Promise<Outcome> {
  const url = urlOf(item);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);
  // Rejects on abort so a fetch that ignores its signal (a test double, an
  // old polyfill) still times out. Its rejection is handled here so that an
  // abort after success does not surface as an unhandled rejection.
  const timeout = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
  });
  timeout.catch(() => undefined);

  try {
    const response = await Promise.race([
      options.fetchImpl(url, { signal: controller.signal, headers: options.headers, redirect: "follow" }),
      timeout,
    ]);
    if (!response.ok) {
      return { skip: { reason: "status", message: `HTTP ${response.status}`, status: response.status } };
    }
    const contentType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    if (contentType && !contentType.startsWith("image/") && contentType !== "application/octet-stream") {
      return { skip: { reason: "content_type", message: `Content-Type is ${contentType}` } };
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > options.maxBytes) {
      return { skip: { reason: "too_large", message: `Content-Length ${formatBytes(declared)} is over the ${formatBytes(options.maxBytes)} limit` } };
    }
    const bytes = await Promise.race([readBody(response, options.maxBytes), timeout]);
    if (bytes === undefined) {
      return { skip: { reason: "too_large", message: `Body is over the ${formatBytes(options.maxBytes)} limit` } };
    }
    const mediaType = checkImageBytes(bytes, { maxBytes: options.maxBytes });
    return { source: { label, image: { data: bytes, mediaType } } };
  } catch (error) {
    if (timedOut) return { skip: { reason: "timeout", message: `No response within ${options.timeoutMs} ms` } };
    if (error instanceof ImageSourceError) {
      return { skip: { reason: error.kind === "too_large" ? "too_large" : "unsupported", message: error.message } };
    }
    return { skip: { reason: "fetch", message: error instanceof Error ? error.message : String(error) } };
  } finally {
    clearTimeout(timer);
    if (!timedOut) controller.abort(); // release anything still streaming
  }
}

/**
 * Read a body, giving up as soon as it exceeds `maxBytes`. Streams when the
 * response can, so a lying `Content-Length` — or none — cannot make us
 * hold a 200 MB file in memory before checking it.
 */
async function readBody(response: Response, maxBytes: number): Promise<Uint8Array | undefined> {
  const body = response.body;
  if (!body || typeof body.getReader !== "function") {
    const buffer = new Uint8Array(await response.arrayBuffer());
    return buffer.length > maxBytes ? undefined : buffer;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
