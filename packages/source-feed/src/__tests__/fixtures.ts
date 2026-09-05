/** Small hand-written feeds, one per format. */

export const propertyXml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE listings [ <!ENTITY co "Coastal Stays"> ]>
<!-- exported nightly -->
<listings xmlns="urn:coastal:feed" xmlns:geo="urn:coastal:geo" generated="2026-03-01">
  <listing id="sc-101" status="active">
    <title>Sea Cabin &amp; Sauna</title>
    <description><![CDATA[<p>A cabin by the sea. <b>Sleeps 6</b> in two bedrooms.</p><ul><li>Sauna</li><li>Hot tub</li></ul>]]></description>
    <price currency="EUR">250</price>
    <sleeps>6</sleeps>
    <pets>true</pets>
    <amenity>wifi</amenity>
    <amenity>sauna</amenity>
    <amenity>hot tub</amenity>
    <geo:location>
      <geo:city>Bergen</geo:city>
      <geo:postcode>5003</geo:postcode>
    </geo:location>
    <photo />
  </listing>
  <listing id="cf-202" status="paused">
    <title>City Flat &#8212; 2 min to the station</title>
    <description>Bright flat, third floor, no lift.</description>
    <price currency="GBP">140</price>
    <sleeps>2</sleeps>
    <geo:location><geo:city>Manchester</geo:city></geo:location>
  </listing>
</listings>`;

export const rssXml = `<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Coastal Stays news</title>
    <link>https://coastal-stays.example/news</link>
    <description>What&apos;s new on the coast</description>
    <item>
      <title>Sea Cabin reopens for spring</title>
      <link>https://coastal-stays.example/news/sea-cabin-spring</link>
      <pubDate>Mon, 02 Mar 2026 09:00:00 GMT</pubDate>
      <dc:creator>Ann Berg</dc:creator>
      <category>openings</category>
      <category>cabins</category>
      <guid isPermaLink="false">news-1</guid>
      <description>Short teaser.</description>
      <content:encoded><![CDATA[<p>The <b>Sea Cabin</b> is back from 15 March.</p><p>Nightly rate stays at &euro;250.</p>]]></content:encoded>
    </item>
    <item>
      <title>New: EV charger at the Barn</title>
      <link>https://coastal-stays.example/news/barn-ev</link>
      <pubDate>Tue, 03 Mar 2026 12:30:00 GMT</pubDate>
      <description><![CDATA[Guests can now charge overnight &mdash; 7 kW.]]></description>
    </item>
  </channel>
</rss>`;

export const atomXml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Coastal Stays updates</title>
  <link rel="self" href="https://coastal-stays.example/atom.xml"/>
  <link rel="alternate" href="https://coastal-stays.example/"/>
  <subtitle>Updates from the coast</subtitle>
  <updated>2026-03-03T12:30:00Z</updated>
  <entry>
    <title type="html">Lakehouse &lt;em&gt;now&lt;/em&gt; bookable</title>
    <link rel="enclosure" href="https://coastal-stays.example/lakehouse.jpg"/>
    <link href="https://coastal-stays.example/lakehouse"/>
    <id>urn:uuid:1225c695-cfb8-4ebb-aaaa-80da344efa6a</id>
    <published>2026-03-02T09:00:00Z</published>
    <updated>2026-03-02T10:00:00Z</updated>
    <author><name>Ola Nordmann</name><email>ola@coastal-stays.example</email></author>
    <category term="lakehouse" label="Lakehouse"/>
    <content type="html">&lt;p&gt;Sleeps &lt;b&gt;8&lt;/b&gt;, kayaks included.&lt;/p&gt;</content>
  </entry>
  <entry>
    <title>Summary only</title>
    <link href="https://coastal-stays.example/summary"/>
    <id>urn:uuid:2</id>
    <updated>2026-03-03T12:30:00Z</updated>
    <summary>Just a summary.</summary>
  </entry>
</feed>`;

/** CRLF line endings, a folded DESCRIPTION, escaped text, a TZID, and an RRULE with an EXDATE. */
export const availabilityIcs = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Coastal Stays//Availability//EN",
  "X-WR-CALNAME:Sea Cabin availability",
  "X-WR-TIMEZONE:Europe/Oslo",
  "BEGIN:VEVENT",
  "UID:booking-1@coastal-stays.example",
  "DTSTAMP:20260301T000000Z",
  "DTSTART;VALUE=DATE:20260306",
  "DTEND;VALUE=DATE:20260310",
  "SUMMARY:Booked\\, Smith family",
  "DESCRIPTION:Four nights\\; arriving late. Second line of a long description",
  "  that was folded across physical lines\\nwith an escaped newline.",
  "STATUS:CONFIRMED",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:cleaning@coastal-stays.example",
  "DTSTAMP:20260301T000000Z",
  "DTSTART;TZID=Europe/Oslo:20260302T100000",
  "DTEND;TZID=Europe/Oslo:20260302T130000",
  "RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260427T080000Z",
  "EXDATE;TZID=Europe/Oslo:20260316T100000",
  "SUMMARY:Cleaning block",
  "LOCATION:Sea Cabin, Bergen",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:owner@coastal-stays.example",
  "DTSTAMP:20260301T000000Z",
  "DTSTART;VALUE=DATE:20260320",
  "DURATION:P2D",
  "SUMMARY:Owner stay",
  "TRANSP:OPAQUE",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:reminder@coastal-stays.example",
  "DTSTAMP:20260301T000000Z",
  "DTSTART:20260315T090000Z",
  "DTEND:20260315T093000Z",
  "SUMMARY:Send welcome email",
  "TRANSP:TRANSPARENT",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:cancelled@coastal-stays.example",
  "DTSTAMP:20260301T000000Z",
  "DTSTART;VALUE=DATE:20260325",
  "DTEND;VALUE=DATE:20260327",
  "SUMMARY:Cancelled booking",
  "STATUS:CANCELLED",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n");

export const apiJson = {
  meta: { requestId: "req-9f8e7d", generatedAt: "2026-03-01T00:00:00Z", page: 1, total: 2 },
  data: {
    listings: [
      {
        id: "sc-101",
        title: "Sea Cabin & Sauna",
        description: "A cabin by the sea.\nSleeps 6 in two bedrooms.",
        price: { amount: 250, currency: "EUR" },
        sleeps: 6,
        pets: true,
        amenities: ["wifi", "sauna", "hot tub"],
        photos: [],
        host: { name: "Ann Berg", email: "ann@coastal-stays.example", phone: "+47 555 0100" },
        rating: null,
        address: { city: "Bergen", postcode: "5003", country: "NO" },
      },
      {
        id: "cf-202",
        title: "City Flat",
        price: { amount: 140, currency: "GBP" },
        sleeps: 2,
        amenities: ["wifi"],
        host: { name: "Sam Lee", email: "sam@coastal-stays.example" },
        extras: {},
        address: { city: "Manchester", country: "GB" },
      },
    ],
  },
};
