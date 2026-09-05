import { describe, it, expect } from "vitest";
import {
  FeedError,
  decodeXmlEntities,
  parseXml,
  selectElements,
  textOf,
  xmlItems,
  xmlSource,
  xmlToText,
} from "../index.js";
import { propertyXml } from "./fixtures.js";

describe("parseXml", () => {
  it("builds an element tree with namespaces stripped, entities and CDATA decoded", () => {
    const root = parseXml(propertyXml);
    expect(root.name).toBe("listings");
    expect(root.attributes).toEqual({ generated: "2026-03-01" });
    const [first] = selectElements(root, "listings/listing");
    expect(first.attributes).toEqual({ id: "sc-101", status: "active" });
    expect(textOf(selectElements(first, "listing/title")[0])).toBe("Sea Cabin & Sauna");
    expect(textOf(selectElements(first, "listing/description")[0])).toContain("<b>Sleeps 6</b>");
    expect(selectElements(root, "listings/listing/location/city").map(textOf)).toEqual(["Bergen", "Manchester"]);
  });

  it("keeps prefixes and xmlns attributes when asked", () => {
    const root = parseXml(propertyXml, { namespaces: true });
    expect(root.attributes.xmlns).toBe("urn:coastal:feed");
    expect(selectElements(root, "listings/listing/geo:location/geo:city").map(textOf)).toEqual(["Bergen", "Manchester"]);
  });

  it("skips the prolog, DOCTYPE, comments and processing instructions, and a BOM", () => {
    const root = parseXml('\uFEFF<?xml version="1.0"?><!DOCTYPE a><?pi x?><!-- c --><a><?pi y?><!-- d -->x</a>');
    expect(root).toEqual({ name: "a", attributes: {}, children: ["x"] });
  });

  it("decodes numeric and the five named entities in text and attributes", () => {
    expect(decodeXmlEntities("&lt;&amp;&gt;&quot;&apos;&#65;&#x42;&nbsp;")).toBe("<&>\"'AB&nbsp;");
    const root = parseXml("<a t='&quot;q&quot; &amp; &#169;'>&lt;b&gt;</a>");
    expect(root.attributes.t).toBe('"q" & ©');
    expect(root.children).toEqual(["<b>"]);
  });

  it("reports mismatched, unclosed and stray tags with line numbers", () => {
    expect(() => parseXml("<a>\n<b>\n</a>")).toThrow("Closing tag </a> does not match open <b> (line 3)");
    expect(() => parseXml("<a>\n<b>")).toThrow("Unclosed element <b>");
    expect(() => parseXml("<a></a></a>")).toThrow("with no open element");
    expect(() => parseXml("<a></a><b/>")).toThrow("A second root element <b>");
    expect(() => parseXml("<a x=1></a>")).toThrow('Attribute "x" in <a> is not quoted');
    expect(() => parseXml("<a><![CDATA[oops</a>")).toThrow("Unterminated CDATA section");
    expect(() => parseXml("text only")).toThrow("Text outside the root element");
    expect(() => parseXml("")).toThrow("No root element found");
    expect(() => parseXml(123 as unknown as string)).toThrow("Expected a string of XML, got number");
    try {
      parseXml("<a>\n<b>\n</a>");
    } catch (error) {
      expect(error).toBeInstanceOf(FeedError);
      expect((error as FeedError).format).toBe("xml");
      expect((error as FeedError).line).toBe(3);
    }
  });

  it("refuses input over the size guard", () => {
    expect(() => parseXml("<a>" + "x".repeat(100) + "</a>", { maxInputChars: 50 })).toThrow(/over the 50-character limit/);
    expect(parseXml("<a>" + "x".repeat(100) + "</a>", { maxInputChars: 200 }).name).toBe("a");
  });
});

describe("selectElements", () => {
  it("walks a simple path from the root, with wildcards and //", () => {
    const root = parseXml(propertyXml);
    expect(selectElements(root, "listings/listing").length).toBe(2);
    expect(selectElements(root, "/listings/listing/title").length).toBe(2);
    expect(selectElements(root, "*/listing/*/city").map(textOf)).toEqual(["Bergen", "Manchester"]);
    expect(selectElements(root, "//city").map(textOf)).toEqual(["Bergen", "Manchester"]);
    expect(selectElements(root, "wrong/listing")).toEqual([]);
    expect(() => selectElements(root, "")).toThrow("Empty selector");
    expect(() => selectElements(root, "a//b")).toThrow("Malformed selector");
  });
});

describe("xmlToText", () => {
  it("renders an outline with attributes as @name, repeated elements repeated, HTML text converted", () => {
    const text = xmlToText(propertyXml);
    expect(text).toContain("listings:\n  @generated: 2026-03-01\n  listing:\n    @id: sc-101\n    @status: active\n    title: Sea Cabin & Sauna");
    expect(text).toContain("description:\n      A cabin by the sea. Sleeps 6 in two bedrooms.\n      \n      - Sauna\n      - Hot tub");
    expect(text).toContain("price: 250\n      @currency: EUR");
    expect(text).toContain("amenity: wifi\n    amenity: sauna\n    amenity: hot tub");
    expect(text).toContain("location:\n      city: Bergen\n      postcode: 5003");
    expect(text).toContain("photo: (empty)");
    expect(text).toContain("title: City Flat — 2 min to the station");
    expect(text).not.toContain("xmlns");
    expect(text).not.toContain("geo:");
    expect(text).not.toContain("<b>");
  });

  it("can leave markup in text alone", () => {
    expect(xmlToText(propertyXml, { html: false })).toContain("<b>Sleeps 6</b>");
  });

  it("renders mixed content and honours maxDepth", () => {
    expect(xmlToText("<p>Hello <b>world</b> again</p>")).toBe("p:\n  Hello\n  b: world\n  again");
    expect(xmlToText("<a><b><c>1</c><d>2</d></b></a>", { maxDepth: 1 })).toBe("a:\n  b: 12");
  });
});

describe("xmlSource and xmlItems", () => {
  it("labels the whole document as one source", () => {
    const source = xmlSource(propertyXml, "Property feed");
    expect(source.label).toBe("Property feed");
    expect(source.text.startsWith("listings:")).toBe(true);
    expect(xmlSource("<a/>").label).toBeUndefined();
  });

  it("splits a feed into one source per matched element", () => {
    const items = xmlItems(propertyXml, "listings/listing", "Listing");
    expect(items.map((s) => s.label)).toEqual(["Listing 1", "Listing 2"]);
    expect(items[0].text.startsWith("listing:\n  @id: sc-101")).toBe(true);
    expect(items[0].text).not.toContain("cf-202");
    expect(items[1].text).toContain("city: Manchester");
  });

  it("defaults the label to the last step of the selector", () => {
    expect(xmlItems(propertyXml, "listings/listing")[0].label).toBe("listing 1");
  });

  it("throws when the selector matches nothing", () => {
    expect(() => xmlItems(propertyXml, "listings/property")).toThrow(
      'Selector "listings/property" matched nothing under root <listings>',
    );
  });
});
