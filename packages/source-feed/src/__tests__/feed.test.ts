import { describe, it, expect } from "vitest";
import { FeedError, entryToText, feedItems, feedSource, parseFeed } from "../index.js";
import { atomXml, propertyXml, rssXml } from "./fixtures.js";

describe("parseFeed", () => {
  it("reads RSS 2.0: channel, items, dc:creator, content:encoded over description", () => {
    const feed = parseFeed(rssXml);
    expect(feed.kind).toBe("rss");
    expect(feed.title).toBe("Coastal Stays news");
    expect(feed.link).toBe("https://coastal-stays.example/news");
    expect(feed.description).toBe("What's new on the coast");
    expect(feed.entries).toHaveLength(2);
    const [first, second] = feed.entries;
    expect(first.title).toBe("Sea Cabin reopens for spring");
    expect(first.link).toBe("https://coastal-stays.example/news/sea-cabin-spring");
    expect(first.published).toBe("Mon, 02 Mar 2026 09:00:00 GMT");
    expect(first.author).toBe("Ann Berg");
    expect(first.id).toBe("news-1");
    expect(first.categories).toEqual(["openings", "cabins"]);
    expect(first.content).toBe("The Sea Cabin is back from 15 March.\n\nNightly rate stays at €250.");
    expect(second.author).toBeUndefined();
    expect(second.content).toBe("Guests can now charge overnight — 7 kW.");
  });

  it("reads Atom: alternate link, published over updated, author name, escaped HTML content", () => {
    const feed = parseFeed(atomXml);
    expect(feed.kind).toBe("atom");
    expect(feed.title).toBe("Coastal Stays updates");
    expect(feed.link).toBe("https://coastal-stays.example/");
    expect(feed.description).toBe("Updates from the coast");
    const [first, second] = feed.entries;
    expect(first.title).toBe("Lakehouse now bookable");
    expect(first.link).toBe("https://coastal-stays.example/lakehouse");
    expect(first.published).toBe("2026-03-02T09:00:00Z");
    expect(first.author).toBe("Ola Nordmann");
    expect(first.categories).toEqual(["Lakehouse"]);
    expect(first.content).toContain("Sleeps 8");
    expect(first.content).toContain("kayaks included.");
    expect(first.content).not.toContain("<");
    expect(second.published).toBe("2026-03-03T12:30:00Z");
    expect(second.content).toBe("Just a summary.");
  });

  it("reads RSS 1.0 (RDF) items", () => {
    const rdf = `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/">
      <channel><title>Old feed</title></channel>
      <item><title>One</title><link>https://x.example/1</link></item>
    </rdf:RDF>`;
    const feed = parseFeed(rdf);
    expect(feed.title).toBe("Old feed");
    expect(feed.entries.map((e) => e.title)).toEqual(["One"]);
  });

  it("rejects XML that is not a feed, and malformed XML", () => {
    expect(() => parseFeed(propertyXml)).toThrow("Not an RSS or Atom feed: root element is <listings>");
    expect(() => parseFeed("<rss><channel>")).toThrow(FeedError);
    try {
      parseFeed(propertyXml);
    } catch (error) {
      expect((error as FeedError).format).toBe("feed");
    }
  });
});

describe("feedItems", () => {
  it("renders each entry as labelled lines and converted content", () => {
    const items = feedItems(rssXml);
    expect(items.map((s) => s.label)).toEqual(["Entry 1", "Entry 2"]);
    expect(items[0].text).toBe(
      [
        "Title: Sea Cabin reopens for spring",
        "Link: https://coastal-stays.example/news/sea-cabin-spring",
        "Published: Mon, 02 Mar 2026 09:00:00 GMT",
        "Author: Ann Berg",
        "Categories: openings, cabins",
        "",
        "The Sea Cabin is back from 15 March.",
        "",
        "Nightly rate stays at €250.",
      ].join("\n"),
    );
    expect(items[1].text).not.toContain("Author:");
  });

  it("takes a label and works for Atom too", () => {
    const items = feedItems(atomXml, "Update");
    expect(items.map((s) => s.label)).toEqual(["Update 1", "Update 2"]);
    expect(items[1].text).toBe("Title: Summary only\nLink: https://coastal-stays.example/summary\nPublished: 2026-03-03T12:30:00Z\n\nJust a summary.");
  });

  it("renders an entry with nothing in it without crashing", () => {
    expect(entryToText({ categories: [] })).toBe("(empty entry)");
    expect(entryToText({ categories: [], content: "only body" })).toBe("only body");
  });
});

describe("feedSource", () => {
  it("renders the feed head and every entry as one source", () => {
    const source = feedSource(rssXml, "News");
    expect(source.label).toBe("News");
    expect(source.text.startsWith("Feed: Coastal Stays news\nLink: https://coastal-stays.example/news\nDescription: What's new on the coast\n\nEntry 1\nTitle:")).toBe(true);
    expect(source.text).toContain("\n\nEntry 2\nTitle: New: EV charger at the Barn");
  });
});
