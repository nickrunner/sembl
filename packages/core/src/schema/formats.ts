/**
 * Named string formats a field can be constrained to.
 *
 * Each one is validated locally, described in the prompt, and — where JSON
 * Schema has a matching keyword — emitted in the schema dialects that honour
 * it. They exist for the fields every pipeline ends up normalising by hand:
 * a country that came back as "United States", a state as "Calif.", a
 * currency as "dollars".
 *
 * - `"url"` — an absolute http(s) URL.
 * - `"email"` — one address, no display name.
 * - `"date"` — a calendar date as `YYYY-MM-DD`.
 * - `"datetime"` — an ISO 8601 timestamp, e.g. `2026-09-05T14:30:00Z`.
 * - `"iso-country"` — an ISO 3166-1 alpha-2 code: `US`, `DE`, `PT`.
 * - `"us-state"` — a two-letter USPS state code: `CA`, `NY`, `DC`, `PR`.
 * - `"us-state-name"` — a state's full name: `California`, `New York`.
 * - `"currency"` — an ISO 4217 code: `USD`, `EUR`, `GBP`.
 */
export type FieldFormat =
  | "url"
  | "email"
  | "date"
  | "datetime"
  | "iso-country"
  | "us-state"
  | "us-state-name"
  | "currency";

export const FIELD_FORMATS: readonly FieldFormat[] = [
  "url",
  "email",
  "date",
  "datetime",
  "iso-country",
  "us-state",
  "us-state-name",
  "currency",
];

/** ISO 3166-1 alpha-2, current assignments. */
const ISO_COUNTRIES = new Set(
  (
    "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ " +
    "CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR " +
    "GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP " +
    "KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT " +
    "MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW " +
    "SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG " +
    "UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW"
  ).split(" "),
);

/** USPS codes for the 50 states, DC, and the inhabited territories, with names. */
const US_STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado",
  CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho",
  IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada",
  NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina",
  ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas",
  UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia",
  WI: "Wisconsin", WY: "Wyoming", DC: "District of Columbia", PR: "Puerto Rico", GU: "Guam",
  VI: "U.S. Virgin Islands", AS: "American Samoa", MP: "Northern Mariana Islands",
};
const US_STATE_NAMES = new Set(Object.values(US_STATES));

/** ISO 4217 active currency codes. */
const CURRENCIES = new Set(
  (
    "AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD CAD CDF CHF " +
    "CLP CNY COP CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HTG " +
    "HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA " +
    "MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD " +
    "RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX " +
    "USD UYU UZS VES VND VUV WST XAF XCD XOF XPF YER ZAR ZMW ZWG"
  ).split(" "),
);

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;

function isCalendarDate(y: number, m: number, d: number): boolean {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/**
 * Check a string against a format. Returns a message describing what was
 * expected when the value does not conform, undefined when it does.
 */
export function validateFormat(value: string, format: FieldFormat): string | undefined {
  switch (format) {
    case "url": {
      try {
        const url = new URL(value);
        if (url.protocol === "http:" || url.protocol === "https:") return undefined;
      } catch {
        // fall through to the message
      }
      return `Expected an absolute http(s) URL, got ${JSON.stringify(value)}`;
    }
    case "email":
      return EMAIL.test(value) ? undefined : `Expected an email address, got ${JSON.stringify(value)}`;
    case "date": {
      const m = DATE.exec(value);
      if (m && isCalendarDate(Number(m[1]), Number(m[2]), Number(m[3]))) return undefined;
      return `Expected a calendar date as YYYY-MM-DD, got ${JSON.stringify(value)}`;
    }
    case "datetime":
      return DATETIME.test(value) && !Number.isNaN(Date.parse(value))
        ? undefined
        : `Expected an ISO 8601 timestamp, got ${JSON.stringify(value)}`;
    case "iso-country":
      return ISO_COUNTRIES.has(value)
        ? undefined
        : `Expected an ISO 3166-1 alpha-2 country code such as US or DE, got ${JSON.stringify(value)}`;
    case "us-state":
      return value in US_STATES
        ? undefined
        : `Expected a two-letter USPS state code such as CA or NY, got ${JSON.stringify(value)}`;
    case "us-state-name":
      return US_STATE_NAMES.has(value)
        ? undefined
        : `Expected a US state's full name such as California, got ${JSON.stringify(value)}`;
    case "currency":
      return CURRENCIES.has(value)
        ? undefined
        : `Expected an ISO 4217 currency code such as USD or EUR, got ${JSON.stringify(value)}`;
  }
}

/** The phrase the prompt uses to state a format. */
export function describeFormat(format: FieldFormat): string {
  switch (format) {
    case "url":
      return "an absolute http(s) URL";
    case "email":
      return "an email address";
    case "date":
      return "a calendar date as YYYY-MM-DD";
    case "datetime":
      return "an ISO 8601 timestamp (e.g. 2026-09-05T14:30:00Z)";
    case "iso-country":
      return "an ISO 3166-1 alpha-2 country code (e.g. US, DE, PT), never a country name";
    case "us-state":
      return "a two-letter USPS state code (e.g. CA, NY), never the state's name";
    case "us-state-name":
      return "a US state's full name (e.g. California, New York), never its abbreviation";
    case "currency":
      return "an ISO 4217 currency code (e.g. USD, EUR, GBP), never a symbol or a word";
  }
}

/**
 * JSON Schema keywords for a format, in the standard dialect. The four with
 * a JSON Schema `format` of their own use it; the code formats state their
 * shape as a pattern, since a `format` a validator does not know is ignored.
 */
export function formatToJsonSchema(format: FieldFormat): Record<string, unknown> {
  switch (format) {
    case "url":
      return { format: "uri" };
    case "email":
      return { format: "email" };
    case "date":
      return { format: "date" };
    case "datetime":
      return { format: "date-time" };
    case "iso-country":
    case "us-state":
      return { pattern: "^[A-Z]{2}$" };
    case "currency":
      return { pattern: "^[A-Z]{3}$" };
    case "us-state-name":
      return {};
  }
}
