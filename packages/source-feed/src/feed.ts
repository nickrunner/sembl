import type { Source } from "@sembl/core";
import { htmlToText } from "@sembl/source-html";
import { FeedError, itemLabel, pushScalar, renderOutline, tidyText } from "./shared.js";
import type { OutlineLine, SizeGuardOptions } from "./shared.js";
import { childElement, childElements, parseXml, textOf } from "./xml.js";
import type { XmlElement } from "./xml.js";

/** One entry of an RSS or Atom feed, as data. */
export interface FeedEntry {
  title?: string;
  link?: string;
  /** The `published`/`pubDate` (or `updated` when that is all Atom gave). */
  published?: string;
  author?: string;
  id?: string;
  categories: string[];
  /** The entry's content as plain text, HTML converted, or its summary when there is no content. */
  content?: string;
}

/** A parsed feed: its own title and link, and its entries in feed order. */
export interface ParsedFeed {
  kind: "rss" | "atom";
  title?: string;
  link?: string;
  description?: string;
  entries: FeedEntry[];
}

/** Options for {@link parseFeed}, {@link feedItems} and {@link feedSource}. */
export type FeedSourceOptions = SizeGuardOptions;

function clean(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const tidy = tidyText(text);
  return tidy === "" ? undefined : tidy;
}

/** Text of a child element after HTML conversion, or undefined. */
function richText(element: XmlElement | undefined): string | undefined {
  if (!element) return undefined;
  const raw = textOf(element);
  if (!raw) return undefined;
  // Atom `type="xhtml"` puts the markup inline as child elements; textOf
  // already flattened those to their text, and htmlToText decodes anything
  // that was escaped.
  return clean(htmlToText(raw));
}

/** An Atom `<link>`: the alternate link if there is one, else the first with an href. */
function atomLink(element: XmlElement): string | undefined {
  const links = childElements(element, "link");
  const alternate = links.find((l) => (l.attributes.rel ?? "alternate") === "alternate" && l.attributes.href);
  return (alternate ?? links.find((l) => l.attributes.href))?.attributes.href?.trim();
}

function rssEntry(item: XmlElement): FeedEntry {
  const enclosure = childElement(item, "enclosure")?.attributes.url;
  const entry: FeedEntry = { categories: childElements(item, "category").map(textOf).filter(Boolean) };
  entry.title = clean(textOf(childElement(item, "title")));
  entry.link = clean(textOf(childElement(item, "link"))) ?? (enclosure ? enclosure.trim() : undefined);
  entry.published = clean(textOf(childElement(item, "pubDate") ?? childElement(item, "date")));
  entry.author = clean(textOf(childElement(item, "creator") ?? childElement(item, "author")));
  entry.id = clean(textOf(childElement(item, "guid")));
  // `content:encoded` (prefix stripped to `encoded`) is the full text; `description` is the fallback.
  entry.content = richText(childElement(item, "encoded")) ?? richText(childElement(item, "description"));
  return entry;
}

function atomEntry(item: XmlElement): FeedEntry {
  const entry: FeedEntry = {
    categories: childElements(item, "category")
      .map((c) => c.attributes.label ?? c.attributes.term ?? "")
      .map((c) => c.trim())
      .filter(Boolean),
  };
  entry.title = clean(htmlToText(textOf(childElement(item, "title"))));
  entry.link = atomLink(item);
  entry.published = clean(textOf(childElement(item, "published") ?? childElement(item, "updated")));
  const author = childElement(item, "author");
  entry.author = clean(textOf(author ? childElement(author, "name") ?? author : undefined));
  entry.id = clean(textOf(childElement(item, "id")));
  entry.content = richText(childElement(item, "content")) ?? richText(childElement(item, "summary"));
  return entry;
}

/**
 * Parse an RSS 2.0, RSS 1.0 (RDF) or Atom feed into entries. The format is
 * detected from the root element; anything else is a {@link FeedError}.
 */
export function parseFeed(xml: string, options: FeedSourceOptions = {}): ParsedFeed {
  const root = parseXml(xml, options);
  if (root.name === "feed") {
    return {
      kind: "atom",
      title: clean(textOf(childElement(root, "title"))),
      link: atomLink(root),
      description: clean(textOf(childElement(root, "subtitle"))),
      entries: childElements(root, "entry").map(atomEntry),
    };
  }
  if (root.name === "rss" || root.name === "RDF") {
    const channel = childElement(root, "channel") ?? root;
    const items = root.name === "rss" ? childElements(channel, "item") : childElements(root, "item");
    return {
      kind: "rss",
      title: clean(textOf(childElement(channel, "title"))),
      link: clean(textOf(childElement(channel, "link"))),
      description: clean(textOf(childElement(channel, "description"))),
      entries: items.map(rssEntry),
    };
  }
  throw new FeedError("feed", `Not an RSS or Atom feed: root element is <${root.name}>, expected <rss>, <feed> or <rdf:RDF>`);
}

/**
 * Render one entry as a block: `Title`, `Link`, `Published`, `Author` and
 * `Categories` lines for the fields it has, a blank line, then the content
 * as plain text.
 */
export function entryToText(entry: FeedEntry): string {
  const lines: OutlineLine[] = [];
  if (entry.title) pushScalar(lines, 0, "Title", entry.title);
  if (entry.link) pushScalar(lines, 0, "Link", entry.link);
  if (entry.published) pushScalar(lines, 0, "Published", entry.published);
  if (entry.author) pushScalar(lines, 0, "Author", entry.author);
  if (entry.categories.length > 0) pushScalar(lines, 0, "Categories", entry.categories.join(", "));
  const head = renderOutline(lines);
  if (!entry.content) return head || "(empty entry)";
  return head ? `${head}\n\n${entry.content}` : entry.content;
}

/**
 * One source per entry of an RSS or Atom feed, for `coerceMany`. Each holds
 * the entry's title, link, date and author as labelled lines and its
 * content converted from HTML to text. Labels are numbered from 1.
 */
export function feedItems(xml: string, label = "Entry", options?: FeedSourceOptions): Source[] {
  return parseFeed(xml, options).entries.map((entry, i) => ({
    label: itemLabel(label, i + 1),
    text: entryToText(entry),
  }));
}

/**
 * A whole feed as one source: the feed's title and description, then every
 * entry as a block. For a feed of any length prefer {@link feedItems}.
 */
export function feedSource(xml: string, label?: string, options?: FeedSourceOptions): Source {
  const feed = parseFeed(xml, options);
  const head: OutlineLine[] = [];
  if (feed.title) pushScalar(head, 0, "Feed", feed.title);
  if (feed.link) pushScalar(head, 0, "Link", feed.link);
  if (feed.description) pushScalar(head, 0, "Description", feed.description);
  const sections = [renderOutline(head), ...feed.entries.map((e, i) => `Entry ${i + 1}\n${entryToText(e)}`)].filter(Boolean);
  const text = sections.join("\n\n") || "(empty feed)";
  return label ? { label, text } : { text };
}
