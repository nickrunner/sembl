import { describe, it, expect } from "vitest";
import { fetchImages } from "../index.js";
import { heicHeader, png, tinyJpeg } from "./fixtures.js";

/** A fetch that serves a table of responses and records what was asked. */
function fakeFetch(
  routes: Record<string, () => Response | Promise<Response>>,
): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const route = routes[url];
    if (!route) return new Response("not found", { status: 404 });
    const signal = init?.signal;
    return new Promise<Response>((resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      Promise.resolve(route()).then(resolve, reject);
    });
  }) as typeof fetch;
  return { fetch: impl, calls };
}

const image = (bytes: Uint8Array, type = "image/jpeg", extra: Record<string, string> = {}) => () =>
  new Response(bytes, { headers: { "content-type": type, ...extra } });

describe("fetchImages", () => {
  it("downloads a gallery into labelled image sources, in order, and reports what it skipped", async () => {
    const { fetch, calls } = fakeFetch({
      "https://x/hero.jpg": image(tinyJpeg()),
      "https://x/sauna.png": image(png(4, 4), "image/png"),
      "https://x/missing.jpg": () => new Response("nope", { status: 404 }),
    });
    const result = await fetchImages(
      [{ url: "https://x/hero.jpg", alt: "The cabin from the beach" }, "https://x/missing.jpg", { url: "https://x/sauna.png" }],
      { fetch },
    );
    expect(result.sources.map((s) => s.label)).toEqual(["The cabin from the beach", "Image 3"]);
    expect(result.sources.map((s) => "data" in s.image && s.image.mediaType)).toEqual(["image/jpeg", "image/png"]);
    expect(result.skipped).toEqual([{ url: "https://x/missing.jpg", reason: "status", message: "HTTP 404", status: 404 }]);
    expect(calls).toHaveLength(3);
  });

  it("trusts the bytes over the content type, and skips a non-image content type", async () => {
    const { fetch } = fakeFetch({
      "https://x/a": image(png(2, 2), "image/jpeg"), // header lies
      "https://x/b": image(tinyJpeg(), "application/octet-stream"), // CDN shrug
      "https://x/c": () => new Response("<html>login</html>", { headers: { "content-type": "text/html; charset=utf-8" } }),
      "https://x/d": () => new Response(tinyJpeg()), // no header at all
    });
    const { sources, skipped } = await fetchImages(["https://x/a", "https://x/b", "https://x/c", "https://x/d"], { fetch });
    expect(sources.map((s) => "data" in s.image && s.image.mediaType)).toEqual(["image/png", "image/jpeg", "image/jpeg"]);
    expect(skipped).toEqual([{ url: "https://x/c", reason: "content_type", message: "Content-Type is text/html" }]);
  });

  it("skips bytes that are not an accepted image", async () => {
    const { fetch } = fakeFetch({
      "https://x/heic": image(heicHeader(), "image/heic"),
      "https://x/html": () => new Response(new TextEncoder().encode("<html>oops</html>")), // no content type at all
    });
    const { sources, skipped } = await fetchImages(["https://x/heic", "https://x/html"], { fetch });
    expect(sources).toHaveLength(0);
    expect(skipped.map((s) => s.reason)).toEqual(["unsupported", "unsupported"]);
    expect(skipped[0].message).toContain("HEIC");
  });

  it("enforces maxBytes from the header and from the body", async () => {
    const big = new Uint8Array(2000);
    big.set(tinyJpeg());
    const { fetch } = fakeFetch({
      "https://x/declared": image(tinyJpeg(), "image/jpeg", { "content-length": "999999" }),
      "https://x/actual": image(big),
      "https://x/fine": image(tinyJpeg()),
    });
    const { sources, skipped } = await fetchImages(["https://x/declared", "https://x/actual", "https://x/fine"], { fetch, maxBytes: 1000 });
    expect(sources).toHaveLength(1);
    expect(skipped.map((s) => s.reason)).toEqual(["too_large", "too_large"]);
    expect(skipped[0].message).toContain("Content-Length");
    expect(skipped[1].message).toContain("Body is over");
  });

  it("times out a URL that never answers, without holding up the rest", async () => {
    const { fetch } = fakeFetch({
      "https://x/slow": () => new Promise<Response>(() => undefined),
      "https://x/fast": image(tinyJpeg()),
    });
    const started = Date.now();
    const { sources, skipped } = await fetchImages(["https://x/slow", "https://x/fast"], { fetch, timeoutMs: 50 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(sources).toHaveLength(1);
    expect(skipped).toEqual([{ url: "https://x/slow", reason: "timeout", message: "No response within 50 ms" }]);
  });

  it("times out a fetch that ignores its abort signal", async () => {
    const ignoring = (async () => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
    const { skipped } = await fetchImages(["https://x/stuck"], { fetch: ignoring, timeoutMs: 30 });
    expect(skipped[0].reason).toBe("timeout");
  });

  it("caps the count without fetching the rest", async () => {
    const routes: Record<string, () => Response> = {};
    for (let i = 0; i < 6; i++) routes[`https://x/${i}.jpg`] = image(tinyJpeg());
    const { fetch, calls } = fakeFetch(routes);
    const { sources, skipped } = await fetchImages(Object.keys(routes), { fetch, max: 2, concurrency: 8 });
    expect(sources.map((s) => s.label)).toEqual(["Image 1", "Image 2"]);
    expect(calls).toHaveLength(2);
    expect(skipped).toHaveLength(4);
    expect(skipped.every((s) => s.reason === "count")).toBe(true);
  });

  it("never throws for a fetch that throws", async () => {
    const throwing = (async () => {
      throw new TypeError("getaddrinfo ENOTFOUND");
    }) as unknown as typeof fetch;
    const { skipped } = await fetchImages(["https://nowhere.invalid/a.jpg"], { fetch: throwing });
    expect(skipped).toEqual([{ url: "https://nowhere.invalid/a.jpg", reason: "fetch", message: "getaddrinfo ENOTFOUND" }]);
  });

  it("uses a custom labeller and passes headers through", async () => {
    let seen: RequestInit["headers"];
    const impl = (async (_input: unknown, init?: RequestInit) => {
      seen = init?.headers;
      return new Response(tinyJpeg(), { headers: { "content-type": "image/jpeg" } });
    }) as unknown as typeof fetch;
    const { sources } = await fetchImages(["https://x/1.jpg"], {
      fetch: impl,
      headers: { "user-agent": "sembl-test" },
      label: (item, i) => `Gallery ${i + 1}: ${typeof item === "string" ? item : item.url}`,
    });
    expect(sources[0].label).toBe("Gallery 1: https://x/1.jpg");
    expect(seen).toEqual({ "user-agent": "sembl-test" });
  });

  it("handles an empty list", async () => {
    expect(await fetchImages([], { fetch: fakeFetch({}).fetch })).toEqual({ sources: [], skipped: [] });
  });
});
