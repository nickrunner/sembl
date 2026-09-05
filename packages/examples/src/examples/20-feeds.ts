import { coerce, coerceMany, defineSchema, field } from "@sembl/core";
import type { Infer } from "@sembl/core";
import { availabilityWindows, icsSource, xmlItems, xmlToText } from "@sembl/source-feed";
import { Listing } from "../support/listing-runtime.js";
import { demoProvider, enumResolver, sample } from "../support/provider.js";
import { heading, note, ok, show, table } from "../support/print.js";

export const title = "@sembl/source-feed: a property XML feed through coerceMany, and an availability calendar";

/** What a host wants to know from a calendar at a glance — the model's half of the job. */
const AvailabilitySummary = defineSchema("AvailabilitySummary", "A short reading of a rental's availability calendar.", {
  bookings: field.number("How many confirmed guest bookings the calendar holds, not counting cancelled ones, owner stays or maintenance.", { minimum: 0 }),
  bookedNights: field.number("Total nights across those confirmed guest bookings.", { minimum: 0 }),
  ownerBlocked: field.boolean("Whether the owner has blocked any dates for their own use."),
  nextCheckIn: field.string("Date of the earliest confirmed guest check-in, as YYYY-MM-DD.", { format: "date" }).optional(),
  recurringBlock: field.string("Any recurring block on the calendar, in plain words, including which day and what it is for.").optional(),
  guestNote: field.string("Anything a guest should know before booking — check-in limits, service days — in one sentence.").optional(),
});
type AvailabilitySummary = Infer<typeof AvailabilitySummary>;

export async function run(): Promise<void> {
  const { provider } = demoProvider();

  heading("Part 1 — a partner's XML feed, one source per <listing>");
  const xml = sample("listings-feed.xml");
  const items = xmlItems(xml, "listings/listing", "Listing");
  note(`${xml.length} characters of XML → ${items.length} sources; namespaces stripped, CDATA HTML converted, attributes as @name`);
  show("first 14 lines of Listing 1", items[0].text.split("\n").slice(0, 14).join("\n"));

  const results = await coerceMany<Partial<Listing>>(items, {
    provider,
    schema: Listing,
    enumResolver,
    mode: "partialCoerce",
    onInvalidField: "clamp",
    concurrency: 2,
  });
  table(
    results.map((r) =>
      r.ok
        ? {
            source: items[r.index].label,
            name: r.data.name,
            type: r.data.propertyType,
            sleeps: r.data.sleeps,
            rate: r.data.nightlyRate !== undefined ? `${r.data.nightlyRate} ${r.data.currency ?? ""}` : "",
            pets: r.data.petsAllowed,
            amenities: (r.data.amenities ?? []).join(", "),
            city: r.data.address?.city,
          }
        : { source: items[r.index].label, name: `ERROR: ${(r.error as Error).message.split("\n")[0]}` },
    ),
  );
  ok(`${results.filter((r) => r.ok).length}/${results.length} listings extracted from the feed`);

  heading("Part 2 — an iCalendar availability export");
  const ics = sample("availability.ics");
  const source = icsSource(ics, "Availability calendar");
  note("Folded lines unfolded, escapes undone, all-day DTEND explained as exclusive, the RRULE glossed and kept verbatim.");
  show("rendered calendar", source.text);

  note("The deterministic half needs no model: availabilityWindows expands the recurrence and drops cancelled and transparent events.");
  const busy = availabilityWindows(ics, { from: "2026-03-01", to: "2026-05-01" });
  table(
    busy.map((r) => ({
      from: r.start.toISOString().slice(0, r.allDay ? 10 : 16),
      to: r.end.toISOString().slice(0, r.allDay ? 10 : 16),
      what: r.summary,
    })),
  );

  note("The reading a host wants is the model's half.");
  const summary = await coerce<AvailabilitySummary>(source, { provider, schema: AvailabilitySummary });
  show("AvailabilitySummary", summary);
  if (summary.bookings === 2 && summary.bookedNights === 7) ok("two confirmed bookings, seven nights: the cancelled one and the owner stay were not counted");

  note("xmlToText renders a whole document too, for a feed with one thing in it:");
  show("first 6 lines", xmlToText(xml).split("\n").slice(0, 6).join("\n"));
}
