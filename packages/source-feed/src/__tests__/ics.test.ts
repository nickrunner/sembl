import { describe, it, expect } from "vitest";
import {
  FeedError,
  availabilityWindows,
  describeRRule,
  icsDateToInstant,
  icsEvents,
  icsSource,
  icsToText,
  parseIcs,
  parseIcsDateTime,
  parseIcsDuration,
  parseRRule,
  unescapeIcsText,
  unfoldIcs,
} from "../index.js";
import { availabilityIcs } from "./fixtures.js";

/** A calendar holding one event made of the given lines. */
const wrap = (...lines: string[]) =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", ...lines, "END:VEVENT", "END:VCALENDAR"].join("\n");

const iso = (d: Date) => d.toISOString();

describe("unfolding and escaping", () => {
  it("joins folded lines and keeps the starting line number", () => {
    const lines = unfoldIcs("A:one\r\n two\r\n\tthree\r\nB:four\r\n");
    expect(lines).toEqual([
      { text: "A:onetwothree", line: 1 },
      { text: "B:four", line: 4 },
    ]);
  });

  it("undoes TEXT escapes", () => {
    expect(unescapeIcsText("a\\, b\\; c\\nd\\Ne\\\\f")).toBe("a, b; c\nd\ne\\f");
  });

  it("splits parameters, including quoted ones with colons", () => {
    const cal = parseIcs(wrap('DTSTART;TZID="Europe/Oslo":20260302T100000', 'ATTENDEE;CN="Berg, Ann";ROLE=CHAIR:mailto:ann@x.example'));
    const [event] = cal.events;
    expect(event.start?.tzid).toBe("Europe/Oslo");
    const attendee = event.properties.find((p) => p.name === "ATTENDEE");
    expect(attendee?.params).toEqual({ CN: "Berg, Ann", ROLE: "CHAIR" });
    expect(attendee?.value).toBe("mailto:ann@x.example");
  });
});

describe("parseIcs", () => {
  it("reads the calendar and its events", () => {
    const cal = parseIcs(availabilityIcs);
    expect(cal.name).toBe("Sea Cabin availability");
    expect(cal.timezone).toBe("Europe/Oslo");
    expect(cal.product).toBe("-//Coastal Stays//Availability//EN");
    expect(cal.events).toHaveLength(5);
    const [booking, cleaning, owner, reminder, cancelled] = cal.events;
    expect(booking.summary).toBe("Booked, Smith family");
    expect(booking.description).toBe(
      "Four nights; arriving late. Second line of a long description that was folded across physical lines\nwith an escaped newline.",
    );
    expect(booking.start).toMatchObject({ allDay: true, year: 2026, month: 3, day: 6 });
    expect(booking.end).toMatchObject({ allDay: true, day: 10 });
    expect(booking.status).toBe("CONFIRMED");
    expect(cleaning.start).toMatchObject({ allDay: false, hour: 10, tzid: "Europe/Oslo", utc: false });
    expect(cleaning.rrule?.freq).toBe("WEEKLY");
    expect(cleaning.exdates).toHaveLength(1);
    expect(cleaning.location).toBe("Sea Cabin, Bergen");
    expect(owner.duration).toMatchObject({ days: 2 });
    expect(reminder.transparency).toBe("TRANSPARENT");
    expect(reminder.start).toMatchObject({ utc: true, hour: 9 });
    expect(cancelled.status).toBe("CANCELLED");
  });

  it("reports structural faults with line numbers", () => {
    expect(() => parseIcs("BEGIN:VEVENT\nEND:VEVENT")).toThrow("Expected BEGIN:VCALENDAR, found BEGIN:VEVENT (line 1)");
    expect(() => parseIcs("BEGIN:VCALENDAR\nBEGIN:VEVENT\nEND:VCALENDAR")).toThrow("END:VCALENDAR does not match BEGIN:VEVENT (line 3)");
    expect(() => parseIcs("BEGIN:VCALENDAR\nBEGIN:VEVENT")).toThrow("Unclosed BEGIN:VEVENT");
    expect(() => parseIcs("BEGIN:VCALENDAR\nno colon here\nEND:VCALENDAR")).toThrow('Malformed content line "no colon here" (line 2)');
    expect(() => parseIcs("VERSION:2.0")).toThrow("Property VERSION outside BEGIN:VCALENDAR");
    expect(() => parseIcs("")).toThrow("Empty iCalendar input");
    expect(() => parseIcs(wrap("DTSTART:2026-03-01"))).toThrow('Cannot read date "2026-03-01" (line 4)');
    expect(() => parseIcs(wrap("DTSTART:20261301"))).toThrow("out of range");
    expect(() => parseIcs(wrap("DTSTART:20260301", "RRULE:FREQ=FORTNIGHTLY"))).toThrow('Unknown RRULE frequency "FORTNIGHTLY"');
    expect(() => parseIcs(wrap("DURATION:P"))).toThrow('Cannot read duration "P"');
    try {
      parseIcs("BEGIN:VCALENDAR\nBEGIN:VEVENT\nEND:VCALENDAR");
    } catch (error) {
      expect(error).toBeInstanceOf(FeedError);
      expect((error as FeedError).format).toBe("ics");
      expect((error as FeedError).line).toBe(3);
    }
  });

  it("refuses input over the size guard", () => {
    expect(() => parseIcs(availabilityIcs, { maxInputChars: 100 })).toThrow(/over the 100-character limit/);
  });
});

describe("dates, durations and rules", () => {
  it("parses dates, date-times, UTC and TZID values", () => {
    expect(parseIcsDateTime("20260301")).toMatchObject({ allDay: true, year: 2026, month: 3, day: 1, utc: false });
    expect(parseIcsDateTime("20260301T153000Z")).toMatchObject({ allDay: false, hour: 15, minute: 30, utc: true });
    expect(parseIcsDateTime("20260301T1530", { TZID: "Europe/Oslo" })).toMatchObject({ hour: 15, second: 0, tzid: "Europe/Oslo" });
    expect(parseIcsDateTime("20260301T153000", { VALUE: "DATE" })).toMatchObject({ allDay: true, hour: 0 });
  });

  it("converts through the zone, DST included, and treats all-day dates as UTC midnight", () => {
    expect(iso(icsDateToInstant(parseIcsDateTime("20260302T100000", { TZID: "Europe/Oslo" })))).toBe("2026-03-02T09:00:00.000Z");
    expect(iso(icsDateToInstant(parseIcsDateTime("20260406T100000", { TZID: "Europe/Oslo" })))).toBe("2026-04-06T08:00:00.000Z");
    expect(iso(icsDateToInstant(parseIcsDateTime("20260302T100000", { TZID: "America/Los_Angeles" })))).toBe("2026-03-02T18:00:00.000Z");
    expect(iso(icsDateToInstant(parseIcsDateTime("20260302")))).toBe("2026-03-02T00:00:00.000Z");
    expect(iso(icsDateToInstant(parseIcsDateTime("20260302T100000")))).toBe("2026-03-02T10:00:00.000Z");
  });

  it("falls back to a VTIMEZONE offset for a zone Node does not know, and to floating time otherwise", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VTIMEZONE",
      "TZID:Customer Standard Time",
      "BEGIN:STANDARD",
      "TZOFFSETFROM:+0200",
      "TZOFFSETTO:+0100",
      "END:STANDARD",
      "END:VTIMEZONE",
      "BEGIN:VEVENT",
      'DTSTART;TZID="Customer Standard Time":20260302T100000',
      "DTEND;TZID=Nowhere/Unknown:20260302T110000",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\n");
    const cal = parseIcs(ics);
    expect(cal.zones.fixedOffsets).toEqual({ "Customer Standard Time": 60 });
    expect(iso(icsDateToInstant(cal.events[0].start!, cal.zones))).toBe("2026-03-02T09:00:00.000Z");
    expect(iso(icsDateToInstant(cal.events[0].end!, cal.zones))).toBe("2026-03-02T11:00:00.000Z");
  });

  it("parses durations", () => {
    expect(parseIcsDuration("P2D")).toMatchObject({ days: 2, negative: false });
    expect(parseIcsDuration("-PT1H30M")).toMatchObject({ hours: 1, minutes: 30, negative: true });
    expect(parseIcsDuration("P1W")).toMatchObject({ weeks: 1 });
    expect(() => parseIcsDuration("2 days")).toThrow(FeedError);
  });

  it("parses RRULEs and keeps what it does not model", () => {
    const rule = parseRRule("FREQ=MONTHLY;INTERVAL=2;BYDAY=-1FR,2TU;COUNT=5;WKST=SU;BYSETPOS=1");
    expect(rule).toMatchObject({ freq: "MONTHLY", interval: 2, count: 5, wkst: 0, other: { BYSETPOS: "1" } });
    expect(rule.byDay).toEqual([
      { weekday: 5, ordinal: -1 },
      { weekday: 2, ordinal: 2 },
    ]);
    expect(() => parseRRule("INTERVAL=2")).toThrow("RRULE has no FREQ");
    expect(() => parseRRule("FREQ=WEEKLY;BYDAY=XX")).toThrow('Bad RRULE BYDAY entry "XX"');
  });

  it("glosses the common rules in plain English and refuses the rest", () => {
    const start = parseIcsDateTime("20260304T100000");
    const gloss = (r: string) => describeRRule(parseRRule(r), start);
    expect(gloss("FREQ=DAILY")).toBe("every day");
    expect(gloss("FREQ=DAILY;INTERVAL=3;COUNT=1")).toBe("every 3 days, 1 time");
    expect(gloss("FREQ=WEEKLY")).toBe("every week on Wednesday");
    expect(gloss("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR;UNTIL=20260601")).toBe("every 2 weeks on Monday, Wednesday and Friday until 2026-06-01");
    expect(gloss("FREQ=MONTHLY")).toBe("every month on the 4th");
    expect(gloss("FREQ=MONTHLY;BYMONTHDAY=1,15")).toBe("every month on the 1st and the 15th");
    expect(gloss("FREQ=MONTHLY;BYDAY=2TU")).toBe("every month on the 2nd Tuesday");
    expect(gloss("FREQ=MONTHLY;BYDAY=-1FR;COUNT=12")).toBe("every month on the last Friday, 12 times");
    expect(gloss("FREQ=YEARLY")).toBe("every year on 4 March");
    expect(gloss("FREQ=YEARLY;BYMONTH=6,7")).toBe("every year in June and July on the 4th");
    expect(gloss("FREQ=YEARLY;BYMONTH=11;BYDAY=4TH")).toBe("every year on the 4th Thursday of November");
    expect(gloss("FREQ=WEEKLY;BYDAY=MO;BYSETPOS=1")).toBeUndefined();
    expect(gloss("FREQ=HOURLY")).toBeUndefined();
  });
});

describe("icsToText", () => {
  it("renders the calendar head and every event as a readable block", () => {
    const text = icsToText(availabilityIcs);
    expect(text.startsWith("Calendar: Sea Cabin availability\nTime zone: Europe/Oslo\nEvents: 5\n\nEvent: Booked, Smith family\n")).toBe(true);
    expect(text).toContain("  Starts: 2026-03-06 (all day)\n  Ends: 2026-03-10 (exclusive: last day is 2026-03-09)\n  Length: 4 days\n  Status: CONFIRMED\n  Description:\n    Four nights; arriving late.");
    expect(text).toContain("Event: Cleaning block\n  Starts: 2026-03-02 10:00 (Europe/Oslo)\n  Ends: 2026-03-02 13:00 (Europe/Oslo)\n  Length: 3 hours\n  Repeats: every week on Monday until 2026-04-27 08:00 UTC (RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260427T080000Z)\n  Except: 2026-03-16 10:00 (Europe/Oslo)\n  Location: Sea Cabin, Bergen");
    expect(text).toContain("Event: Owner stay\n  Starts: 2026-03-20 (all day)\n  Duration: P2D\n  Length: 2 days");
    expect(text).toContain("Event: Send welcome email\n  Starts: 2026-03-15 09:00 UTC\n  Ends: 2026-03-15 09:30 UTC\n  Length: 30 minutes\n  Shows as: free (does not block time)");
    expect(text).not.toContain("UID");
    expect(text).not.toContain("DTSTAMP");
  });

  it("keeps a rule it cannot gloss verbatim, and can include UIDs or drop descriptions", () => {
    const text = icsToText(wrap("UID:u1", "DTSTART:20260301T090000Z", "RRULE:FREQ=WEEKLY;BYDAY=MO;BYSETPOS=1", "DESCRIPTION:secret"), { uid: true, description: false });
    expect(text).toContain("  Repeats: RRULE:FREQ=WEEKLY;BYDAY=MO;BYSETPOS=1\n");
    expect(text).toContain("  UID: u1");
    expect(text).not.toContain("secret");
    expect(text).toContain("Event: (untitled)");
  });

  it("builds sources: the whole calendar or one per event", () => {
    expect(icsSource(availabilityIcs, "Calendar").label).toBe("Calendar");
    const events = icsEvents(availabilityIcs, "Booking");
    expect(events.map((s) => s.label)).toEqual(["Booking 1", "Booking 2", "Booking 3", "Booking 4", "Booking 5"]);
    expect(events[2].text).toBe("Event: Owner stay\n  Starts: 2026-03-20 (all day)\n  Duration: P2D\n  Length: 2 days");
  });
});

describe("availabilityWindows", () => {
  it("returns busy ranges in the window, recurrence expanded, exceptions and free/cancelled events left out", () => {
    const ranges = availabilityWindows(availabilityIcs, { from: "2026-03-01", to: "2026-05-01" });
    expect(ranges.map((r) => [iso(r.start), iso(r.end), r.summary])).toEqual([
      ["2026-03-02T09:00:00.000Z", "2026-03-02T12:00:00.000Z", "Cleaning block"],
      ["2026-03-06T00:00:00.000Z", "2026-03-10T00:00:00.000Z", "Booked, Smith family"],
      ["2026-03-09T09:00:00.000Z", "2026-03-09T12:00:00.000Z", "Cleaning block"],
      ["2026-03-20T00:00:00.000Z", "2026-03-22T00:00:00.000Z", "Owner stay"],
      ["2026-03-23T09:00:00.000Z", "2026-03-23T12:00:00.000Z", "Cleaning block"],
      // Oslo moves to CEST on 29 March: 10:00 local is now 08:00Z.
      ["2026-03-30T08:00:00.000Z", "2026-03-30T11:00:00.000Z", "Cleaning block"],
      ["2026-04-06T08:00:00.000Z", "2026-04-06T11:00:00.000Z", "Cleaning block"],
      ["2026-04-13T08:00:00.000Z", "2026-04-13T11:00:00.000Z", "Cleaning block"],
      ["2026-04-20T08:00:00.000Z", "2026-04-20T11:00:00.000Z", "Cleaning block"],
      // UNTIL is inclusive and lands exactly on this occurrence.
      ["2026-04-27T08:00:00.000Z", "2026-04-27T11:00:00.000Z", "Cleaning block"],
    ]);
    expect(ranges[1]).toMatchObject({ allDay: true, uid: "booking-1@coastal-stays.example" });
    expect(ranges[0].allDay).toBe(false);
  });

  it("clips to the window and can include transparent and cancelled events", () => {
    const narrow = availabilityWindows(availabilityIcs, { from: "2026-03-08", to: "2026-03-16" });
    expect(narrow.map((r) => r.summary)).toEqual(["Booked, Smith family", "Cleaning block"]);
    const all = availabilityWindows(availabilityIcs, { from: "2026-03-01", to: "2026-04-01", includeTransparent: true, includeCancelled: true });
    expect(all.map((r) => r.summary)).toContain("Send welcome email");
    expect(all.map((r) => r.summary)).toContain("Cancelled booking");
  });

  it("merges overlapping and touching ranges when asked", () => {
    const merged = availabilityWindows(availabilityIcs, { from: "2026-03-01", to: "2026-03-12", merge: true });
    expect(merged.map((r) => [iso(r.start), iso(r.end), r.summary])).toEqual([
      ["2026-03-02T09:00:00.000Z", "2026-03-02T12:00:00.000Z", "Cleaning block"],
      ["2026-03-06T00:00:00.000Z", "2026-03-10T00:00:00.000Z", "Booked, Smith family; Cleaning block"],
    ]);
  });

  it("expands daily, monthly and yearly rules with COUNT, BYMONTHDAY and ordinal BYDAY", () => {
    const daily = availabilityWindows(wrap("DTSTART;VALUE=DATE:20260301", "RRULE:FREQ=DAILY;INTERVAL=2;COUNT=3", "SUMMARY:d"), { from: "2026-01-01", to: "2027-01-01" });
    expect(daily.map((r) => iso(r.start).slice(0, 10))).toEqual(["2026-03-01", "2026-03-03", "2026-03-05"]);

    const monthly = availabilityWindows(wrap("DTSTART:20260131T120000Z", "DTEND:20260131T130000Z", "RRULE:FREQ=MONTHLY;COUNT=4"), { from: "2026-01-01", to: "2027-01-01" });
    // Months without a 31st are skipped, as the RFC says.
    expect(monthly.map((r) => iso(r.start).slice(0, 10))).toEqual(["2026-01-31", "2026-03-31", "2026-05-31", "2026-07-31"]);

    const lastFriday = availabilityWindows(wrap("DTSTART:20260327T170000Z", "RRULE:FREQ=MONTHLY;BYDAY=-1FR;COUNT=3"), { from: "2026-01-01", to: "2027-01-01" });
    expect(lastFriday.map((r) => iso(r.start).slice(0, 10))).toEqual(["2026-03-27", "2026-04-24", "2026-05-29"]);

    const byMonthDay = availabilityWindows(wrap("DTSTART:20260101T080000Z", "RRULE:FREQ=MONTHLY;BYMONTHDAY=1,15;UNTIL=20260215T080000Z"), { from: "2026-01-01", to: "2027-01-01" });
    expect(byMonthDay.map((r) => iso(r.start).slice(0, 10))).toEqual(["2026-01-01", "2026-01-15", "2026-02-01", "2026-02-15"]);

    const yearly = availabilityWindows(wrap("DTSTART;VALUE=DATE:20260704", "RRULE:FREQ=YEARLY;COUNT=3"), { from: "2026-01-01", to: "2030-01-01" });
    expect(yearly.map((r) => iso(r.start).slice(0, 10))).toEqual(["2026-07-04", "2027-07-04", "2028-07-04"]);

    const thanksgiving = availabilityWindows(wrap("DTSTART;VALUE=DATE:20261126", "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=4TH;COUNT=2"), { from: "2026-01-01", to: "2030-01-01" });
    expect(thanksgiving.map((r) => iso(r.start).slice(0, 10))).toEqual(["2026-11-26", "2027-11-25"]);
  });

  it("honours WKST for a fortnightly rule, RDATE additions and RECURRENCE-ID overrides", () => {
    // Sunday 1 March 2026. With WKST=MO the Sunday belongs to the week of 23 Feb, so the next
    // Sunday in a fortnightly rule is 15 March; with WKST=SU it is also 15 March — but the
    // Monday after the start differs: 2 March (WKST=SU, same week) vs 9 March (WKST=MO).
    const mo = availabilityWindows(wrap("DTSTART:20260301T100000Z", "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,MO;WKST=MO;COUNT=3"), { from: "2026-01-01", to: "2027-01-01" });
    expect(mo.map((r) => iso(r.start).slice(0, 10))).toEqual(["2026-03-01", "2026-03-09", "2026-03-15"]);
    const su = availabilityWindows(wrap("DTSTART:20260301T100000Z", "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,MO;WKST=SU;COUNT=3"), { from: "2026-01-01", to: "2027-01-01" });
    expect(su.map((r) => iso(r.start).slice(0, 10))).toEqual(["2026-03-01", "2026-03-02", "2026-03-15"]);

    const rdate = availabilityWindows(wrap("DTSTART;VALUE=DATE:20260301", "RDATE;VALUE=DATE:20260310,20260320", "SUMMARY:r"), { from: "2026-01-01", to: "2027-01-01" });
    expect(rdate.map((r) => iso(r.start).slice(0, 10))).toEqual(["2026-03-01", "2026-03-10", "2026-03-20"]);

    const overridden = availabilityWindows(
      wrap(
        "UID:weekly",
        "DTSTART:20260302T100000Z",
        "DTEND:20260302T110000Z",
        "RRULE:FREQ=WEEKLY;COUNT=3",
        "SUMMARY:regular",
      ) .replace("END:VCALENDAR", "BEGIN:VEVENT\nUID:weekly\nRECURRENCE-ID:20260309T100000Z\nDTSTART:20260310T140000Z\nDTEND:20260310T150000Z\nSUMMARY:moved\nEND:VEVENT\nEND:VCALENDAR"),
      { from: "2026-01-01", to: "2027-01-01" },
    );
    expect(overridden.map((r) => [iso(r.start).slice(0, 13), r.summary])).toEqual([
      ["2026-03-02T10", "regular"],
      ["2026-03-10T14", "moved"],
      ["2026-03-16T10", "regular"],
    ]);
  });

  it("keeps wall-clock length across a DST change for zoned events", () => {
    const ranges = availabilityWindows(wrap("DTSTART;TZID=Europe/Oslo:20260328T220000", "DTEND;TZID=Europe/Oslo:20260329T040000"), { from: "2026-03-01", to: "2026-04-01" });
    // 22:00 CET to 04:00 CEST is five real hours.
    expect(ranges[0].end.getTime() - ranges[0].start.getTime()).toBe(5 * 3_600_000);
  });

  it("never runs away on an unbounded rule", () => {
    const started = Date.now();
    const ranges = availabilityWindows(wrap("DTSTART:20200101T000000Z", "RRULE:FREQ=DAILY"), { from: "2026-03-01", to: "2026-03-08" });
    expect(ranges).toHaveLength(7);
    expect(Date.now() - started).toBeLessThan(2000);
    const sparse = availabilityWindows(wrap("DTSTART:20200131T000000Z", "RRULE:FREQ=MONTHLY;BYMONTHDAY=31"), { from: "2026-03-01", to: "2026-06-01" });
    expect(sparse.map((r) => iso(r.start).slice(0, 10))).toEqual(["2026-03-31", "2026-05-31"]);
  });

  it("includes occurrences that began before the window and still overlap it", () => {
    const single = availabilityWindows(wrap("DTSTART;VALUE=DATE:20260227", "DTEND;VALUE=DATE:20260303", "SUMMARY:s"), { from: "2026-03-01", to: "2026-04-01" });
    expect(single.map((r) => iso(r.start).slice(0, 10))).toEqual(["2026-02-27"]);
    const weekly = availabilityWindows(wrap("DTSTART;VALUE=DATE:20260220", "DURATION:P3D", "RRULE:FREQ=WEEKLY", "SUMMARY:w"), { from: "2026-03-01", to: "2026-03-10" });
    expect(weekly.map((r) => iso(r.start).slice(0, 10))).toEqual(["2026-02-27", "2026-03-06"]);
    const old = availabilityWindows(wrap("DTSTART:19700105T090000Z", "DTEND:19700105T100000Z", "RRULE:FREQ=DAILY"), { from: "2030-03-01", to: "2030-03-03" });
    expect(old.map((r) => iso(r.start))).toEqual(["2030-03-01T09:00:00.000Z", "2030-03-02T09:00:00.000Z"]);
  });

  it("rejects a bad window", () => {
    expect(() => availabilityWindows(availabilityIcs, { from: "yesterday", to: "2026-05-01" })).toThrow('Cannot read from "yesterday"');
    expect(() => availabilityWindows(availabilityIcs, { from: "2026-05-01", to: "2026-03-01" })).toThrow("`to` must be after its `from`");
  });
});
