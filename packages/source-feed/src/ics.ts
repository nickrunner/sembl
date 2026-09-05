import type { Source } from "@sembl/core";
import { FeedError, guardInput, itemLabel, pushScalar, renderOutline, tidyText } from "./shared.js";
import type { OutlineLine, SizeGuardOptions } from "./shared.js";

// ---------------------------------------------------------------------------
// Content lines
// ---------------------------------------------------------------------------

/** One content line of an iCalendar file, unfolded and split. */
export interface IcsProperty {
  /** Upper-cased property name, e.g. `DTSTART`. */
  name: string;
  /** Parameters with upper-cased names; quoted values have their quotes removed. */
  params: Record<string, string>;
  /** The value as written, escapes intact. Use {@link unescapeIcsText} for TEXT values. */
  value: string;
  /** The line the property started on, for error messages. */
  line: number;
}

/** A component: VCALENDAR, VEVENT, VTIMEZONE, … with its properties and children. */
export interface IcsComponent {
  name: string;
  properties: IcsProperty[];
  components: IcsComponent[];
}

/**
 * Unfold the physical lines of a file into content lines. RFC 5545 folds
 * long lines by breaking them and starting the continuation with a space
 * or tab; this joins them back, keeping the number of the line each
 * started on.
 */
export function unfoldIcs(ics: string): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  const physical = ics.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/);
  for (let i = 0; i < physical.length; i++) {
    const raw = physical[i];
    if ((raw.startsWith(" ") || raw.startsWith("\t")) && out.length > 0) {
      out[out.length - 1].text += raw.slice(1);
    } else if (raw !== "") {
      out.push({ text: raw, line: i + 1 });
    }
  }
  return out;
}

/** Split `NAME;PARAM=a;OTHER="x:y":value` into its parts. */
function parseContentLine(text: string, line: number): IcsProperty {
  let i = 0;
  const n = text.length;
  while (i < n && text[i] !== ";" && text[i] !== ":") i++;
  const name = text.slice(0, i).trim().toUpperCase();
  if (name === "" || i >= n) {
    throw new FeedError("ics", `Malformed content line "${text.slice(0, 40)}"`, line);
  }
  const params: Record<string, string> = {};
  while (text[i] === ";") {
    i++;
    const eq = text.indexOf("=", i);
    if (eq === -1) throw new FeedError("ics", `Malformed parameter on ${name}`, line);
    const pname = text.slice(i, eq).trim().toUpperCase();
    i = eq + 1;
    let value = "";
    for (;;) {
      if (text[i] === '"') {
        const close = text.indexOf('"', i + 1);
        if (close === -1) throw new FeedError("ics", `Unterminated quoted parameter on ${name}`, line);
        value += text.slice(i + 1, close);
        i = close + 1;
      } else {
        const start = i;
        while (i < n && text[i] !== ";" && text[i] !== ":" && text[i] !== ",") i++;
        value += text.slice(start, i);
      }
      if (text[i] === ",") {
        value += ",";
        i++;
        continue;
      }
      break;
    }
    params[pname] = value;
  }
  if (text[i] !== ":") throw new FeedError("ics", `Malformed content line for ${name}: no ":" found`, line);
  return { name, params, value: text.slice(i + 1), line };
}

/** Undo TEXT escaping: `\n` and `\N` to a newline, `\,` `\;` `\\` to the character. */
export function unescapeIcsText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_m, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

/** Split a multi-valued TEXT property on commas that are not escaped. */
function splitIcsList(value: string): string[] {
  return value
    .split(/(?<!\\),/)
    .map((v) => unescapeIcsText(v).trim())
    .filter(Boolean);
}

/**
 * Parse an iCalendar file into its component tree: BEGIN/END nesting
 * checked, lines unfolded, properties split. Throws a {@link FeedError} for
 * a file that does not start with BEGIN:VCALENDAR, an END that matches no
 * BEGIN, or a component still open at the end.
 */
export function parseIcsComponents(ics: string, options: SizeGuardOptions = {}): IcsComponent {
  const lines = unfoldIcs(guardInput(ics, "ics", options));
  if (lines.length === 0) throw new FeedError("ics", "Empty iCalendar input");
  const stack: IcsComponent[] = [];
  let root: IcsComponent | undefined;

  for (const { text, line } of lines) {
    const prop = parseContentLine(text, line);
    if (prop.name === "BEGIN") {
      const component: IcsComponent = { name: prop.value.trim().toUpperCase(), properties: [], components: [] };
      if (stack.length === 0) {
        if (root) throw new FeedError("ics", `A second top-level BEGIN:${component.name}`, line);
        if (component.name !== "VCALENDAR") throw new FeedError("ics", `Expected BEGIN:VCALENDAR, found BEGIN:${component.name}`, line);
        root = component;
      } else {
        stack[stack.length - 1].components.push(component);
      }
      stack.push(component);
      continue;
    }
    if (prop.name === "END") {
      const name = prop.value.trim().toUpperCase();
      const open = stack.pop();
      if (!open) throw new FeedError("ics", `END:${name} with nothing open`, line);
      if (open.name !== name) throw new FeedError("ics", `END:${name} does not match BEGIN:${open.name}`, line);
      continue;
    }
    if (stack.length === 0) throw new FeedError("ics", `Property ${prop.name} outside BEGIN:VCALENDAR`, line);
    stack[stack.length - 1].properties.push(prop);
  }
  if (stack.length > 0) throw new FeedError("ics", `Unclosed BEGIN:${stack[stack.length - 1].name}`);
  if (!root) throw new FeedError("ics", "No BEGIN:VCALENDAR found");
  return root;
}

// ---------------------------------------------------------------------------
// Dates, durations and recurrence rules
// ---------------------------------------------------------------------------

/** A DATE or DATE-TIME value, as written: wall-clock fields plus how to anchor them. */
export interface IcsDateTime {
  raw: string;
  /** A DATE value with no time. */
  allDay: boolean;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** Written with a trailing Z. */
  utc: boolean;
  /** The TZID parameter, when there was one. */
  tzid?: string;
}

const DATE_TIME = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/;

/** Parse a DATE or DATE-TIME value; the TZID comes from the property's parameters. */
export function parseIcsDateTime(value: string, params: Record<string, string> = {}, line?: number): IcsDateTime {
  const raw = value.trim();
  const m = DATE_TIME.exec(raw);
  if (!m) throw new FeedError("ics", `Cannot read date "${raw}"`, line);
  const allDay = m[4] === undefined || params.VALUE === "DATE";
  const dt: IcsDateTime = {
    raw,
    allDay,
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: allDay ? 0 : Number(m[4]),
    minute: allDay ? 0 : Number(m[5]),
    second: allDay ? 0 : Number(m[6] ?? 0),
    utc: !allDay && m[7] === "Z",
  };
  if (dt.month < 1 || dt.month > 12 || dt.day < 1 || dt.day > 31 || dt.hour > 23 || dt.minute > 59 || dt.second > 60) {
    throw new FeedError("ics", `Date "${raw}" is out of range`, line);
  }
  if (!allDay && !dt.utc && params.TZID) dt.tzid = params.TZID;
  return dt;
}

/** A DURATION value broken into its parts. */
export interface IcsDuration {
  raw: string;
  negative: boolean;
  weeks: number;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

const DURATION = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

export function parseIcsDuration(value: string, line?: number): IcsDuration {
  const raw = value.trim();
  const m = DURATION.exec(raw);
  if (!m || raw === "P" || raw.endsWith("T")) throw new FeedError("ics", `Cannot read duration "${raw}"`, line);
  return {
    raw,
    negative: m[1] === "-",
    weeks: Number(m[2] ?? 0),
    days: Number(m[3] ?? 0),
    hours: Number(m[4] ?? 0),
    minutes: Number(m[5] ?? 0),
    seconds: Number(m[6] ?? 0),
  };
}

function durationMs(d: IcsDuration): number {
  const ms = (((d.weeks * 7 + d.days) * 24 + d.hours) * 60 + d.minutes) * 60_000 + d.seconds * 1000;
  return d.negative ? -ms : ms;
}

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** A BYDAY entry: a weekday (0 = Sunday) with an optional ordinal like `2` or `-1`. */
export interface IcsByDay {
  weekday: number;
  ordinal?: number;
}

/** The parts of an RRULE this package understands. Unknown parts are kept in `other`. */
export interface IcsRRule {
  raw: string;
  freq: "SECONDLY" | "MINUTELY" | "HOURLY" | "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  count?: number;
  until?: IcsDateTime;
  byDay?: IcsByDay[];
  byMonthDay?: number[];
  byMonth?: number[];
  /** Week start for WEEKLY rules with an interval, 0 = Sunday. Default Monday. */
  wkst: number;
  /** Rule parts this package does not expand or gloss, e.g. `BYSETPOS`. */
  other: Record<string, string>;
}

export function parseRRule(value: string, line?: number): IcsRRule {
  const raw = value.trim();
  const rule: IcsRRule = { raw, freq: "DAILY", interval: 1, wkst: 1, other: {} };
  let sawFreq = false;
  for (const part of raw.split(";")) {
    if (part === "") continue;
    const eq = part.indexOf("=");
    if (eq === -1) throw new FeedError("ics", `Malformed RRULE part "${part}"`, line);
    const key = part.slice(0, eq).toUpperCase();
    const val = part.slice(eq + 1);
    switch (key) {
      case "FREQ": {
        const freq = val.toUpperCase();
        if (!["SECONDLY", "MINUTELY", "HOURLY", "DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freq)) {
          throw new FeedError("ics", `Unknown RRULE frequency "${val}"`, line);
        }
        rule.freq = freq as IcsRRule["freq"];
        sawFreq = true;
        break;
      }
      case "INTERVAL": {
        const n = Number(val);
        if (!Number.isInteger(n) || n < 1) throw new FeedError("ics", `Bad RRULE INTERVAL "${val}"`, line);
        rule.interval = n;
        break;
      }
      case "COUNT": {
        const n = Number(val);
        if (!Number.isInteger(n) || n < 1) throw new FeedError("ics", `Bad RRULE COUNT "${val}"`, line);
        rule.count = n;
        break;
      }
      case "UNTIL":
        rule.until = parseIcsDateTime(val, {}, line);
        break;
      case "BYDAY":
        rule.byDay = val.split(",").map((entry) => {
          const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(entry.trim());
          if (!m) throw new FeedError("ics", `Bad RRULE BYDAY entry "${entry}"`, line);
          const day: IcsByDay = { weekday: WEEKDAYS.indexOf(m[2].toUpperCase() as (typeof WEEKDAYS)[number]) };
          if (m[1] !== undefined) day.ordinal = Number(m[1]);
          return day;
        });
        break;
      case "BYMONTHDAY":
        rule.byMonthDay = val.split(",").map((v) => {
          const n = Number(v);
          if (!Number.isInteger(n) || n === 0 || n < -31 || n > 31) throw new FeedError("ics", `Bad RRULE BYMONTHDAY "${v}"`, line);
          return n;
        });
        break;
      case "BYMONTH":
        rule.byMonth = val.split(",").map((v) => {
          const n = Number(v);
          if (!Number.isInteger(n) || n < 1 || n > 12) throw new FeedError("ics", `Bad RRULE BYMONTH "${v}"`, line);
          return n;
        });
        break;
      case "WKST": {
        const idx = WEEKDAYS.indexOf(val.toUpperCase() as (typeof WEEKDAYS)[number]);
        if (idx === -1) throw new FeedError("ics", `Bad RRULE WKST "${val}"`, line);
        rule.wkst = idx;
        break;
      }
      default:
        rule.other[key] = val;
    }
  }
  if (!sawFreq) throw new FeedError("ics", "RRULE has no FREQ", line);
  return rule;
}

function ordinalWord(n: number): string {
  const abs = Math.abs(n);
  const suffix = abs % 100 >= 11 && abs % 100 <= 13 ? "th" : abs % 10 === 1 ? "st" : abs % 10 === 2 ? "nd" : abs % 10 === 3 ? "rd" : "th";
  return `${abs}${suffix}`;
}

function listWords(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/**
 * A plain-English reading of a recurrence rule — "every 2 weeks on Monday
 * and Friday until 2026-06-01" — for the daily, weekly, monthly and yearly
 * forms with INTERVAL, BYDAY, BYMONTHDAY, BYMONTH, COUNT and UNTIL.
 * Returns undefined for a rule that uses anything else, so the caller can
 * fall back to the verbatim RRULE rather than gloss it wrongly.
 */
export function describeRRule(rule: IcsRRule, start?: IcsDateTime): string | undefined {
  if (Object.keys(rule.other).length > 0) return undefined;
  const every = (unit: string) => (rule.interval === 1 ? `every ${unit}` : `every ${rule.interval} ${unit}s`);
  let text: string;
  const monthDays = rule.byMonthDay?.map((d) => (d < 0 ? `${ordinalWord(d)}-to-last day` : `the ${ordinalWord(d)}`));
  const weekdayList = rule.byDay?.map((d) =>
    d.ordinal === undefined
      ? WEEKDAY_NAMES[d.weekday]
      : d.ordinal === -1
        ? `the last ${WEEKDAY_NAMES[d.weekday]}`
        : d.ordinal < 0
          ? `the ${ordinalWord(d.ordinal)}-to-last ${WEEKDAY_NAMES[d.weekday]}`
          : `the ${ordinalWord(d.ordinal)} ${WEEKDAY_NAMES[d.weekday]}`,
  );

  switch (rule.freq) {
    case "DAILY":
      if (rule.byMonthDay) return undefined;
      text = every("day");
      if (weekdayList) text += ` on ${listWords(weekdayList)}`;
      break;
    case "WEEKLY":
      if (rule.byMonthDay) return undefined;
      text = every("week");
      if (weekdayList) text += ` on ${listWords(weekdayList)}`;
      else if (start) text += ` on ${WEEKDAY_NAMES[weekdayOf(start)]}`;
      break;
    case "MONTHLY":
      text = every("month");
      if (monthDays) text += ` on ${listWords(monthDays)}`;
      else if (weekdayList) text += ` on ${listWords(weekdayList)}`;
      else if (start) text += ` on the ${ordinalWord(start.day)}`;
      if (monthDays && weekdayList) text += ` when it falls on ${listWords(weekdayList)}`;
      break;
    case "YEARLY": {
      text = every("year");
      const months = rule.byMonth?.map((m) => MONTH_NAMES[m - 1]);
      if (weekdayList && months) text += ` on ${listWords(weekdayList)} of ${listWords(months)}`;
      else if (weekdayList) text += ` on ${listWords(weekdayList)}`;
      else if (monthDays && months) text += ` on ${listWords(monthDays)} of ${listWords(months)}`;
      else if (months) text += ` in ${listWords(months)}${start ? ` on the ${ordinalWord(start.day)}` : ""}`;
      else if (monthDays) text += ` on ${listWords(monthDays)}`;
      else if (start) text += ` on ${start.day} ${MONTH_NAMES[start.month - 1]}`;
      break;
    }
    default:
      return undefined;
  }
  if (rule.count !== undefined) text += `, ${rule.count} time${rule.count === 1 ? "" : "s"}`;
  if (rule.until) text += ` until ${formatIcsDate(rule.until)}`;
  return text;
}

// ---------------------------------------------------------------------------
// Instants: turning wall-clock values into UTC milliseconds
// ---------------------------------------------------------------------------

/** The wall-clock fields as if they were UTC — the arithmetic space for recurrence. */
function wallMs(dt: IcsDateTime): number {
  return Date.UTC(dt.year, dt.month - 1, dt.day, dt.hour, dt.minute, dt.second);
}

function weekdayOf(dt: IcsDateTime): number {
  return new Date(wallMs(dt)).getUTCDay();
}

const formatterCache = new Map<string, Intl.DateTimeFormat | null>();

function zoneFormatter(tz: string): Intl.DateTimeFormat | null {
  let cached = formatterCache.get(tz);
  if (cached !== undefined) return cached;
  try {
    cached = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    cached = null;
  }
  formatterCache.set(tz, cached);
  return cached;
}

/** The zone's offset from UTC, in minutes, at an instant. */
function offsetAt(formatter: Intl.DateTimeFormat, utcMs: number): number {
  const parts: Record<string, number> = {};
  for (const p of formatter.formatToParts(new Date(utcMs))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second);
  return Math.round((asUtc - utcMs) / 60_000);
}

/**
 * Whether Node knows a zone by this name. Vendor calendars sometimes write
 * Windows names ("W. Europe Standard Time"); those fall back to the
 * VTIMEZONE's fixed offset, or to floating time.
 */
export function isKnownTimeZone(tz: string): boolean {
  return zoneFormatter(tz) !== null;
}

/** How wall-clock values are anchored: the zone lookup for a calendar. */
export interface ZoneContext {
  /** Fixed offsets, in minutes, for TZIDs that only a VTIMEZONE explains. */
  fixedOffsets: Record<string, number>;
}

/** Convert wall-clock fields in a zone to a UTC instant, DST handled by Intl. */
function wallToUtc(wall: number, tzid: string | undefined, zones: ZoneContext): number {
  if (!tzid) return wall;
  const formatter = zoneFormatter(tzid);
  if (formatter) {
    let offset = offsetAt(formatter, wall);
    let utc = wall - offset * 60_000;
    const check = offsetAt(formatter, utc);
    if (check !== offset) {
      offset = check;
      utc = wall - offset * 60_000;
    }
    return utc;
  }
  const fixed = zones.fixedOffsets[tzid];
  return fixed === undefined ? wall : wall - fixed * 60_000;
}

/** The wall-clock reading, as UTC-anchored ms, of an instant in a zone. */
function utcToWall(instant: number, tzid: string | undefined, zones: ZoneContext): number {
  if (!tzid) return instant;
  const formatter = zoneFormatter(tzid);
  if (formatter) return instant + offsetAt(formatter, instant) * 60_000;
  const fixed = zones.fixedOffsets[tzid];
  return fixed === undefined ? instant : instant + fixed * 60_000;
}

/** The UTC instant of a date-time; an all-day date is midnight UTC of that day. */
export function icsDateToInstant(dt: IcsDateTime, zones: ZoneContext = { fixedOffsets: {} }): Date {
  return new Date(dt.utc || dt.allDay ? wallMs(dt) : wallToUtc(wallMs(dt), dt.tzid, zones));
}

/** Parse a `+0100` / `-0530` TZOFFSET into minutes. */
function parseOffset(value: string): number | undefined {
  const m = /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec(value.trim());
  if (!m) return undefined;
  const minutes = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === "-" ? -minutes : minutes;
}

// ---------------------------------------------------------------------------
// Events and calendars
// ---------------------------------------------------------------------------

/** A VEVENT with the properties that matter for reading and scheduling it. */
export interface IcsEvent {
  uid?: string;
  summary?: string;
  description?: string;
  location?: string;
  status?: string;
  /** `OPAQUE` (busy, the default) or `TRANSPARENT` (does not block time). */
  transparency: "OPAQUE" | "TRANSPARENT";
  url?: string;
  organizer?: string;
  categories: string[];
  start?: IcsDateTime;
  end?: IcsDateTime;
  duration?: IcsDuration;
  rrule?: IcsRRule;
  rdates: IcsDateTime[];
  exdates: IcsDateTime[];
  /** Set on an event that overrides one occurrence of a recurring event with the same UID. */
  recurrenceId?: IcsDateTime;
  /** Every property of the VEVENT, for anything not modelled above. */
  properties: IcsProperty[];
}

/** A parsed calendar. */
export interface IcsCalendar {
  /** `X-WR-CALNAME`, which most exporters write. */
  name?: string;
  /** `X-WR-TIMEZONE`, the calendar's default zone. */
  timezone?: string;
  /** `PRODID`. */
  product?: string;
  events: IcsEvent[];
  zones: ZoneContext;
  /** The component tree, for VTODO, VFREEBUSY or anything else. */
  root: IcsComponent;
}

function first(component: IcsComponent, name: string): IcsProperty | undefined {
  return component.properties.find((p) => p.name === name);
}

function textProp(component: IcsComponent, name: string): string | undefined {
  const prop = first(component, name);
  if (!prop) return undefined;
  const text = tidyText(unescapeIcsText(prop.value));
  return text === "" ? undefined : text;
}

function dateProp(component: IcsComponent, name: string): IcsDateTime | undefined {
  const prop = first(component, name);
  return prop ? parseIcsDateTime(prop.value, prop.params, prop.line) : undefined;
}

function dateListProps(component: IcsComponent, name: string): IcsDateTime[] {
  const out: IcsDateTime[] = [];
  for (const prop of component.properties) {
    if (prop.name !== name) continue;
    for (const value of prop.value.split(",")) {
      // An RDATE may be a PERIOD (`start/end`); the start is what matters here.
      const start = value.includes("/") ? value.slice(0, value.indexOf("/")) : value;
      if (start.trim() !== "") out.push(parseIcsDateTime(start, prop.params, prop.line));
    }
  }
  return out;
}

function toEvent(component: IcsComponent): IcsEvent {
  const transp = first(component, "TRANSP")?.value.trim().toUpperCase();
  const organizer = first(component, "ORGANIZER");
  const duration = first(component, "DURATION");
  const rrule = first(component, "RRULE");
  const event: IcsEvent = {
    transparency: transp === "TRANSPARENT" ? "TRANSPARENT" : "OPAQUE",
    categories: component.properties.filter((p) => p.name === "CATEGORIES").flatMap((p) => splitIcsList(p.value)),
    rdates: dateListProps(component, "RDATE"),
    exdates: dateListProps(component, "EXDATE"),
    properties: component.properties,
  };
  event.uid = first(component, "UID")?.value.trim() || undefined;
  event.summary = textProp(component, "SUMMARY");
  event.description = textProp(component, "DESCRIPTION");
  event.location = textProp(component, "LOCATION");
  event.status = first(component, "STATUS")?.value.trim().toUpperCase() || undefined;
  event.url = first(component, "URL")?.value.trim() || undefined;
  if (organizer) {
    const cn = organizer.params.CN;
    const address = organizer.value.replace(/^mailto:/i, "").trim();
    event.organizer = cn ? (address ? `${cn} <${address}>` : cn) : address || undefined;
  }
  event.start = dateProp(component, "DTSTART");
  event.end = dateProp(component, "DTEND");
  if (duration) event.duration = parseIcsDuration(duration.value, duration.line);
  if (rrule) event.rrule = parseRRule(rrule.value, rrule.line);
  event.recurrenceId = dateProp(component, "RECURRENCE-ID");
  return event;
}

/** Fixed offsets from VTIMEZONE components, for zones Node does not know. */
function fixedOffsets(root: IcsComponent): Record<string, number> {
  const offsets: Record<string, number> = {};
  for (const tz of root.components) {
    if (tz.name !== "VTIMEZONE") continue;
    const tzid = first(tz, "TZID")?.value.trim();
    if (!tzid || isKnownTimeZone(tzid)) continue;
    const standard = tz.components.find((c) => c.name === "STANDARD") ?? tz.components[0];
    const to = standard && first(standard, "TZOFFSETTO");
    const offset = to && parseOffset(to.value);
    if (offset !== undefined) offsets[tzid] = offset;
  }
  return offsets;
}

/** Parse an iCalendar file into a calendar with typed events. */
export function parseIcs(ics: string, options: SizeGuardOptions = {}): IcsCalendar {
  const root = parseIcsComponents(ics, options);
  const calendar: IcsCalendar = {
    events: root.components.filter((c) => c.name === "VEVENT").map(toEvent),
    zones: { fixedOffsets: fixedOffsets(root) },
    root,
  };
  calendar.name = textProp(root, "X-WR-CALNAME");
  calendar.timezone = first(root, "X-WR-TIMEZONE")?.value.trim() || undefined;
  calendar.product = first(root, "PRODID")?.value.trim() || undefined;
  return calendar;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, "0");

/** `2026-03-01` for a date; `2026-03-01 15:00 (Europe/Oslo)` or `… UTC` for a date-time. */
export function formatIcsDate(dt: IcsDateTime): string {
  const date = `${dt.year}-${pad(dt.month)}-${pad(dt.day)}`;
  if (dt.allDay) return date;
  const time = `${pad(dt.hour)}:${pad(dt.minute)}${dt.second ? `:${pad(dt.second)}` : ""}`;
  if (dt.utc) return `${date} ${time} UTC`;
  return dt.tzid ? `${date} ${time} (${dt.tzid})` : `${date} ${time}`;
}

function shiftDate(dt: IcsDateTime, days: number): IcsDateTime {
  const d = new Date(wallMs(dt) + days * 86_400_000);
  return { ...dt, year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function describeSpan(ms: number, allDay: boolean): string | undefined {
  if (ms <= 0) return undefined;
  const parts: string[] = [];
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  if (days) parts.push(`${days} day${days === 1 ? "" : "s"}`);
  if (!allDay && hours) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  if (!allDay && minutes) parts.push(`${minutes} minute${minutes === 1 ? "" : "s"}`);
  return parts.length ? parts.join(" ") : undefined;
}

/** The length of an event from its DTEND or DURATION, in milliseconds of wall-clock time. */
function eventSpanMs(event: IcsEvent): number | undefined {
  if (event.start && event.end) return wallMs(event.end) - wallMs(event.start);
  if (event.duration) return durationMs(event.duration);
  if (event.start?.allDay) return 86_400_000;
  return undefined;
}

/** Options for rendering. */
export interface IcsSourceOptions extends SizeGuardOptions {
  /** Include each event's UID. Default false: they are long and say nothing. */
  uid?: boolean;
  /** Include each event's DESCRIPTION. Default true. */
  description?: boolean;
}

/** Append one event as an `Event:` block. */
function pushEvent(lines: OutlineLine[], event: IcsEvent, options: IcsSourceOptions): void {
  lines.push({ depth: 0, text: `Event: ${event.summary ?? "(untitled)"}` });
  if (event.start) {
    pushScalar(lines, 1, "Starts", `${formatIcsDate(event.start)}${event.start.allDay ? " (all day)" : ""}`);
  }
  if (event.end) {
    const end = formatIcsDate(event.end);
    pushScalar(lines, 1, "Ends", event.end.allDay ? `${end} (exclusive: last day is ${formatIcsDate(shiftDate(event.end, -1))})` : end);
  } else if (event.duration) {
    pushScalar(lines, 1, "Duration", event.duration.raw);
  }
  const span = eventSpanMs(event);
  const described = span !== undefined ? describeSpan(span, event.start?.allDay ?? false) : undefined;
  if (described && (event.end || event.duration)) pushScalar(lines, 1, "Length", described);
  if (event.rrule) {
    const gloss = describeRRule(event.rrule, event.start);
    pushScalar(lines, 1, "Repeats", gloss ? `${gloss} (RRULE:${event.rrule.raw})` : `RRULE:${event.rrule.raw}`);
  }
  if (event.rdates.length) pushScalar(lines, 1, "Also on", event.rdates.map(formatIcsDate).join(", "));
  if (event.exdates.length) pushScalar(lines, 1, "Except", event.exdates.map(formatIcsDate).join(", "));
  if (event.recurrenceId) pushScalar(lines, 1, "Replaces occurrence", formatIcsDate(event.recurrenceId));
  if (event.location) pushScalar(lines, 1, "Location", event.location);
  if (event.status) pushScalar(lines, 1, "Status", event.status);
  if (event.transparency === "TRANSPARENT") pushScalar(lines, 1, "Shows as", "free (does not block time)");
  if (event.organizer) pushScalar(lines, 1, "Organizer", event.organizer);
  if (event.categories.length) pushScalar(lines, 1, "Categories", event.categories.join(", "));
  if (event.url) pushScalar(lines, 1, "URL", event.url);
  if (options.description !== false && event.description) pushScalar(lines, 1, "Description", event.description);
  if (options.uid && event.uid) pushScalar(lines, 1, "UID", event.uid);
}

/** Render one event as a block of text. */
export function eventToText(event: IcsEvent, options: IcsSourceOptions = {}): string {
  const lines: OutlineLine[] = [];
  pushEvent(lines, event, options);
  return renderOutline(lines);
}

/** Render a parsed calendar: a short header, then every event as a block. */
export function calendarToText(calendar: IcsCalendar, options: IcsSourceOptions = {}): string {
  const head: OutlineLine[] = [];
  if (calendar.name) pushScalar(head, 0, "Calendar", calendar.name);
  if (calendar.timezone) pushScalar(head, 0, "Time zone", calendar.timezone);
  pushScalar(head, 0, "Events", String(calendar.events.length));
  const blocks = calendar.events.map((event) => eventToText(event, options));
  return [renderOutline(head), ...blocks].join("\n\n");
}

/**
 * Render an iCalendar file as readable event blocks: each event's title,
 * start and end (with the zone as written, and all-day ends explained as
 * exclusive), its length, any recurrence rule glossed in plain English
 * with the RRULE kept verbatim, exceptions, location, status and
 * description. Folded lines and escaped text are undone first.
 */
export function icsToText(ics: string, options: IcsSourceOptions = {}): string {
  return calendarToText(parseIcs(ics, options), options);
}

/** A whole calendar as one labelled SEMBL source. */
export function icsSource(ics: string, label?: string, options?: IcsSourceOptions): Source {
  const text = icsToText(ics, options);
  return label ? { label, text } : { text };
}

/** One source per VEVENT, for `coerceMany`. Labels are numbered from 1. */
export function icsEvents(ics: string, label = "Event", options?: IcsSourceOptions): Source[] {
  return parseIcs(ics, options).events.map((event, i) => ({
    label: itemLabel(label, i + 1),
    text: eventToText(event, options),
  }));
}

// ---------------------------------------------------------------------------
// Availability: the deterministic half
// ---------------------------------------------------------------------------

/** A span of time an event occupies. `end` is exclusive. */
export interface BusyRange {
  start: Date;
  end: Date;
  /** The event was an all-day one; its instants are UTC midnights. */
  allDay: boolean;
  summary?: string;
  uid?: string;
}

/** Options for {@link availabilityWindows}. */
export interface AvailabilityOptions extends SizeGuardOptions {
  /** Start of the window, inclusive. */
  from: Date | string;
  /** End of the window, exclusive. */
  to: Date | string;
  /** Coalesce overlapping and touching ranges into one. Default false. */
  merge?: boolean;
  /** Count `TRANSP:TRANSPARENT` events as busy. Default false. */
  includeTransparent?: boolean;
  /** Count `STATUS:CANCELLED` events as busy. Default false. */
  includeCancelled?: boolean;
}

/** Hard ceilings so a pathological rule cannot spin forever. */
const MAX_OCCURRENCES = 20_000;
const MAX_PERIODS = 200_000;

function toDate(value: Date | string, what: string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new FeedError("ics", `Cannot read ${what} "${String(value)}" as a date`);
  return date;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Wall-clock day numbers (UTC ms of midnight) for a month's BY* selection. */
function monthDays(year: number, month: number, rule: IcsRRule, startDay: number): number[] {
  const count = daysInMonth(year, month);
  const days = new Set<number>();
  if (rule.byMonthDay) {
    for (const d of rule.byMonthDay) {
      const day = d > 0 ? d : count + 1 + d;
      if (day >= 1 && day <= count) days.add(day);
    }
  }
  if (rule.byDay) {
    const chosen = new Set<number>();
    for (const { weekday, ordinal } of rule.byDay) {
      const matching: number[] = [];
      for (let day = 1; day <= count; day++) {
        if (new Date(Date.UTC(year, month - 1, day)).getUTCDay() === weekday) matching.push(day);
      }
      if (ordinal === undefined) matching.forEach((d) => chosen.add(d));
      else {
        const pick = ordinal > 0 ? matching[ordinal - 1] : matching[matching.length + ordinal];
        if (pick !== undefined) chosen.add(pick);
      }
    }
    if (rule.byMonthDay) {
      for (const d of [...days]) if (!chosen.has(d)) days.delete(d);
    } else {
      chosen.forEach((d) => days.add(d));
    }
  }
  if (!rule.byMonthDay && !rule.byDay && startDay <= count) days.add(startDay);
  return [...days].sort((a, b) => a - b);
}

/**
 * The wall-clock starts (as UTC-anchored ms) of a recurring event that fall
 * in `[keepFrom, stopWall)`, in order, honouring INTERVAL, COUNT, UNTIL,
 * BYDAY, BYMONTHDAY, BYMONTH and WKST. DTSTART is always the first
 * occurrence. Occurrences before `keepFrom` count toward COUNT but are not
 * returned, so a rule that has run daily for years costs a loop, not memory.
 */
function expandRule(
  start: IcsDateTime,
  rule: IcsRRule,
  keepFrom: number,
  stopWall: number,
  untilWall: number | undefined,
): number[] {
  const first = wallMs(start);
  const out: number[] = [];
  let counted = 1;
  const timeOfDay = ((start.hour * 60 + start.minute) * 60 + start.second) * 1000;
  const push = (wall: number): boolean => {
    if (untilWall !== undefined && wall > untilWall) return false;
    if (wall >= stopWall) return false;
    if (wall > first) {
      counted++;
      if (wall >= keepFrom) out.push(wall);
    }
    if (rule.count !== undefined && counted >= rule.count) return false;
    return out.length < MAX_OCCURRENCES;
  };
  if (first >= keepFrom && first < stopWall) out.push(first);
  if ((rule.count !== undefined && rule.count <= 1) || first >= stopWall) return out;

  const DAY = 86_400_000;
  switch (rule.freq) {
    case "DAILY": {
      const weekdays = rule.byDay?.map((d) => d.weekday);
      for (let k = 1; k < MAX_PERIODS; k++) {
        const wall = first + k * rule.interval * DAY;
        if (weekdays && !weekdays.includes(new Date(wall).getUTCDay())) {
          if (wall >= stopWall || (untilWall !== undefined && wall > untilWall)) break;
          continue;
        }
        if (!push(wall)) break;
      }
      break;
    }
    case "WEEKLY": {
      const weekdays = [...new Set(rule.byDay?.map((d) => d.weekday) ?? [weekdayOf(start)])];
      const startDay = first - timeOfDay;
      const offsetFromWkst = (weekdayOf(start) - rule.wkst + 7) % 7;
      const weekStart = startDay - offsetFromWkst * DAY;
      const offsets = weekdays.map((w) => (w - rule.wkst + 7) % 7).sort((a, b) => a - b);
      let done = false;
      for (let k = 0; k < MAX_PERIODS && !done; k++) {
        const base = weekStart + k * rule.interval * 7 * DAY;
        for (const o of offsets) {
          const wall = base + o * DAY + timeOfDay;
          if (wall <= first) continue;
          if (!push(wall)) {
            done = true;
            break;
          }
        }
        if (base > stopWall) break;
      }
      break;
    }
    case "MONTHLY": {
      let done = false;
      for (let k = 0; k < MAX_PERIODS && !done; k++) {
        const total = start.month - 1 + k * rule.interval;
        const year = start.year + Math.floor(total / 12);
        const month = (total % 12) + 1;
        if (Date.UTC(year, month - 1, 1) > stopWall) break;
        for (const day of monthDays(year, month, rule, start.day)) {
          const wall = Date.UTC(year, month - 1, day) + timeOfDay;
          if (wall <= first) continue;
          if (!push(wall)) {
            done = true;
            break;
          }
        }
      }
      break;
    }
    case "YEARLY": {
      let done = false;
      const months = rule.byMonth ?? [start.month];
      const dayRule: IcsRRule = rule.byDay || rule.byMonthDay ? rule : { ...rule, byMonthDay: [start.day] };
      for (let k = 0; k < MAX_PERIODS && !done; k++) {
        const year = start.year + k * rule.interval;
        if (Date.UTC(year, 0, 1) > stopWall) break;
        const monthList = rule.byDay && !rule.byMonth && !rule.byMonthDay ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] : months;
        for (const month of monthList) {
          for (const day of monthDays(year, month, dayRule, start.day)) {
            const wall = Date.UTC(year, month - 1, day) + timeOfDay;
            if (wall <= first) continue;
            if (!push(wall)) {
              done = true;
              break;
            }
          }
          if (done) break;
        }
      }
      break;
    }
    default:
      // SECONDLY/MINUTELY/HOURLY are not expanded: only the first occurrence is reported.
      break;
  }
  return out;
}

/**
 * The busy ranges in a window, as data and without a model: every
 * occurrence of every event that overlaps `[from, to)`, recurrence rules
 * expanded (daily, weekly, monthly, yearly with INTERVAL, COUNT, UNTIL,
 * BYDAY, BYMONTHDAY, BYMONTH), EXDATE and RDATE applied, RECURRENCE-ID
 * overrides honoured, TZIDs converted through the platform's zone data,
 * transparent and cancelled events left out. Sorted by start. An all-day
 * range runs from UTC midnight to UTC midnight of its exclusive end.
 */
export function availabilityWindows(ics: string, options: AvailabilityOptions): BusyRange[] {
  const from = toDate(options.from, "from").getTime();
  const to = toDate(options.to, "to").getTime();
  if (to <= from) throw new FeedError("ics", "The window's `to` must be after its `from`");
  const calendar = parseIcs(ics, options);
  const zones = calendar.zones;

  // Overrides: an event with RECURRENCE-ID replaces that occurrence of the master with the same UID.
  const overridden = new Map<string, Set<number>>();
  for (const event of calendar.events) {
    if (event.uid && event.recurrenceId) {
      const set = overridden.get(event.uid) ?? new Set<number>();
      set.add(icsDateToInstant(event.recurrenceId, zones).getTime());
      overridden.set(event.uid, set);
    }
  }

  // Wall-clock generation must stop at the window's end plus the widest
  // zone offset there is, so nothing in a far-west zone is lost.
  const SLACK = 26 * 3_600_000;
  const ranges: BusyRange[] = [];

  for (const event of calendar.events) {
    if (!event.start) continue;
    if (!options.includeTransparent && event.transparency === "TRANSPARENT") continue;
    if (!options.includeCancelled && event.status === "CANCELLED") continue;
    const span = eventSpanMs(event) ?? 0;
    const toInstant = (wall: number): number =>
      event.start!.utc || event.start!.allDay ? wall : wallToUtc(wall, event.start!.tzid, zones);
    const spanFor = (startInstant: number, wall: number): number => {
      // Keep the wall-clock length, so a 3-night stay is 3 nights across a DST change.
      if (event.start!.allDay || event.start!.utc || !event.start!.tzid) return startInstant + span;
      return toInstant(wall + span);
    };

    let starts: number[];
    if (event.rrule) {
      // UNTIL is inclusive. A date-only UNTIL on a timed event covers that
      // whole day; a UTC UNTIL on a zoned event is read in the event's zone.
      const until = event.rrule.until;
      let untilWall: number | undefined;
      if (until) {
        if (until.allDay) untilWall = wallMs(until) + (event.start.allDay ? 0 : 86_400_000 - 1);
        else if (until.utc) untilWall = utcToWall(wallMs(until), event.start.tzid, zones);
        else untilWall = wallMs(until);
      }
      // An occurrence can still overlap the window if it started up to one
      // span (plus zone slack) before it.
      starts = expandRule(event.start, event.rrule, from - SLACK - Math.max(span, 0), to + SLACK, untilWall);
    } else {
      starts = [wallMs(event.start)];
    }
    for (const rdate of event.rdates) starts.push(wallMs(rdate));
    const excluded = new Set(event.exdates.map((d) => icsDateToInstant(d, zones).getTime()));
    const replaced = event.uid && !event.recurrenceId ? overridden.get(event.uid) : undefined;

    const seen = new Set<number>();
    for (const wall of starts) {
      const startInstant = toInstant(wall);
      if (seen.has(startInstant) || excluded.has(startInstant) || replaced?.has(startInstant)) continue;
      seen.add(startInstant);
      const endInstant = Math.max(spanFor(startInstant, wall), startInstant);
      if (startInstant >= to) continue;
      // A zero-length event counts when its instant is inside the window.
      if (endInstant === startInstant ? startInstant < from : endInstant <= from) continue;
      const range: BusyRange = { start: new Date(startInstant), end: new Date(endInstant), allDay: event.start.allDay };
      if (event.summary) range.summary = event.summary;
      if (event.uid) range.uid = event.uid;
      ranges.push(range);
    }
  }

  ranges.sort((a, b) => a.start.getTime() - b.start.getTime() || a.end.getTime() - b.end.getTime());
  if (!options.merge) return ranges;

  const merged: BusyRange[] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range.start.getTime() <= last.end.getTime()) {
      if (range.end > last.end) last.end = range.end;
      if (range.summary && last.summary !== range.summary) {
        last.summary = last.summary ? `${last.summary}; ${range.summary}` : range.summary;
      }
      last.allDay = last.allDay && range.allDay;
      if (last.uid !== range.uid) delete last.uid;
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}
