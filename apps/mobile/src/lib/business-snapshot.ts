/**
 * A self-provided aggregate snapshot is parsed on-device and remains in app
 * memory. The format intentionally has no free-text or customer-level fields.
 * Keep this contract in sync with src/lib/business-snapshot.ts in the website.
 */
export const BUSINESS_SNAPSHOT_MAX_BYTES = 16_384;
/** Bounds keep sums across all three channels safely precise for currency display. */
export const BUSINESS_SNAPSHOT_MAX_TRANSACTIONS_PER_ROW = 1_000_000_000;
export const BUSINESS_SNAPSHOT_MAX_MINOR_PER_ROW = 1_000_000_000_000;

/**
 * Numeric minor units from SIX's ISO 4217 List One, published 2026-09-17.
 * https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-one.xml
 * Codes without a numeric minor unit are deliberately excluded.
 */
const currencyDigitGroups = [
  [0, "BIF CLP DJF GNF ISK JPY KMF KRW PYG RWF UGX UYI VND VUV XAF XOF XPF"],
  [2, "AED AFN ALL AMD AOA ARS AUD AWG AZN BAM BBD BDT BMD BND BOB BOV BRL BSD BTN BWP BYN BZD CAD CDF CHE CHF CHW CNY COP COU CRC CUP CVE CZK DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GTQ GYD HKD HNL HTG HUF IDR ILS INR IRR JMD KES KGS KHR KPW KYD KZT LAK LBP LKR LRD LSL MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MXV MYR MZN NAD NGN NIO NOK NPR NZD PAB PEN PGK PHP PKR PLN QAR RON RSD RUB SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP SZL THB TJS TMT TOP TRY TTD TWD TZS UAH USD USN UYU UZS VED VES WST XAD XCD XCG YER ZAR ZMW ZWG"],
  [3, "BHD IQD JOD KWD LYD OMR TND"],
  [4, "CLF UYW"],
] as const;

type MinorDigits = 0 | 2 | 3 | 4;
export const BUSINESS_SNAPSHOT_ISO_PUBLISHED = "2026-09-17";
export const BUSINESS_SNAPSHOT_CURRENCY_MINOR_DIGITS: Readonly<Record<string, MinorDigits>> = Object.freeze(
  Object.fromEntries(currencyDigitGroups.flatMap(([digits, codes]) => codes.split(" ").map((code) => [code, digits]))) as Record<string, MinorDigits>,
);

export function businessCurrencyMinorDigits(currency: string): MinorDigits | null {
  return Object.prototype.hasOwnProperty.call(BUSINESS_SNAPSHOT_CURRENCY_MINOR_DIGITS, currency)
    ? BUSINESS_SNAPSHOT_CURRENCY_MINOR_DIGITS[currency]
    : null;
}

/** Format exact whole minor units with pinned ISO precision, never guessed scale. */
export function formatBusinessMinorAmount(value: number, currency: string): string {
  const digits = businessCurrencyMinorDigits(currency);
  if (digits === null || !Number.isSafeInteger(value) || value < 0
      || value > BUSINESS_SNAPSHOT_MAX_MINOR_PER_ROW * 3) return "Unavailable";

  const raw = String(value).padStart(digits + 1, "0");
  const whole = digits ? raw.slice(0, -digits) : raw;
  const fraction = digits ? `.${raw.slice(-digits)}` : "";
  const fallback = `${currency} ${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${fraction}`;

  try {
    const formatter = new Intl.NumberFormat("en-GB", {
      style: "currency", currency, minimumFractionDigits: digits, maximumFractionDigits: digits,
    });
    const options = formatter.resolvedOptions();
    const smallestUnit = digits === 0 ? 1 : 1 / 10 ** digits;
    if (options.minimumFractionDigits !== digits || options.maximumFractionDigits !== digits
        || formatter.format(smallestUnit) === formatter.format(0)) return fallback;
    return formatter.format(value / 10 ** digits);
  } catch {
    return fallback;
  }
}


export const BUSINESS_SNAPSHOT_HEADERS = [
  "window_days",
  "period",
  "start_date",
  "end_exclusive",
  "channel",
  "currency",
  "transactions",
  "gross_minor",
  "refund_minor",
  "source_updated_at",
] as const;

export const BUSINESS_SNAPSHOT_CHANNELS = ["online", "in_person", "other"] as const;
export type BusinessSnapshotChannel = (typeof BUSINESS_SNAPSHOT_CHANNELS)[number];
export type BusinessSnapshotPeriodName = "previous" | "current";
export type BusinessSnapshotWindow = 7 | 30;

export const BUSINESS_SNAPSHOT_CHANNEL_LABELS: Record<BusinessSnapshotChannel, string> = {
  online: "Online",
  in_person: "In person",
  other: "Other",
};

export type BusinessSnapshotRow = {
  period: BusinessSnapshotPeriodName;
  channel: BusinessSnapshotChannel;
  transactions: number;
  grossMinor: number;
  refundMinor: number;
};

export type BusinessSnapshotPeriod = {
  startDate: string;
  endExclusive: string;
  transactions: number;
  grossMinor: number;
  refundMinor: number;
};

export type BusinessSnapshot = {
  windowDays: BusinessSnapshotWindow;
  currency: string;
  sourceUpdatedAt: string;
  periods: Record<BusinessSnapshotPeriodName, BusinessSnapshotPeriod>;
  rows: BusinessSnapshotRow[];
  summary: {
    transactionChangePct: number | null;
    refundRatioPct: number | null;
  };
};

export type BusinessSnapshotProvenance = {
  trustState: "self-provided-unverified";
  audience: "customer-business";
  sourceKind: "aggregate-csv";
  authorization: {
    state: "user-attested";
    basis: "import-confirmation";
    independentlyVerified: false;
    attestedAt: string;
    clock: "native-device-clock" | "browser-device-clock";
  };
  population: { state: "uploader-defined-unverified" };
  metricDefinitionVersion: "business-aggregate-csv-v1";
  windowDays: BusinessSnapshotWindow;
  currency: string;
  channels: readonly BusinessSnapshotChannel[];
  periods: Readonly<Record<BusinessSnapshotPeriodName, Pick<BusinessSnapshotPeriod, "startDate" | "endExclusive">>>;
  sourceUpdatedAt: { value: string; basis: "csv-stated"; authenticated: false };
  processedAt: { value: string; basis: "native-device-clock" | "browser-device-clock"; authenticated: false };
  freshness: { state: "unknown"; reason: "The source timestamp is user-provided and unauthenticated." };
  completeness: {
    state: "user-attested";
    structuralValidation: "passed";
    sourceCoverageVerified: false;
  };
};

export type BusinessSnapshotReport = {
  snapshot: BusinessSnapshot;
  provenance: BusinessSnapshotProvenance;
};

/** Attach device-local trust metadata without presenting self-attestation as provider verification. */
export function createBusinessSnapshotReport(
  snapshot: BusinessSnapshot,
  attestedAt: string,
  processedAt: string,
  clock: BusinessSnapshotProvenance["authorization"]["clock"],
): BusinessSnapshotReport {
  return {
    snapshot,
    provenance: {
      trustState: "self-provided-unverified",
      audience: "customer-business",
      sourceKind: "aggregate-csv",
      authorization: {
        state: "user-attested",
        basis: "import-confirmation",
        independentlyVerified: false,
        attestedAt,
        clock,
      },
      population: { state: "uploader-defined-unverified" },
      metricDefinitionVersion: "business-aggregate-csv-v1",
      windowDays: snapshot.windowDays,
      currency: snapshot.currency,
      channels: [...new Set(snapshot.rows.map((row) => row.channel))].sort(),
      periods: {
        previous: { startDate: snapshot.periods.previous.startDate, endExclusive: snapshot.periods.previous.endExclusive },
        current: { startDate: snapshot.periods.current.startDate, endExclusive: snapshot.periods.current.endExclusive },
      },
      sourceUpdatedAt: { value: snapshot.sourceUpdatedAt, basis: "csv-stated", authenticated: false },
      processedAt: { value: processedAt, basis: clock, authenticated: false },
      freshness: {
        state: "unknown",
        reason: "The source timestamp is user-provided and unauthenticated.",
      },
      completeness: {
        state: "user-attested",
        structuralValidation: "passed",
        sourceCoverageVerified: false,
      },
    },
  };
}

export type BusinessSnapshotResult =
  | { ok: true; snapshot: BusinessSnapshot }
  | { ok: false; error: string };

const errors = {
  size: "The report is too large. Use an aggregate snapshot of at most 16 KB.",
  csv: "The report is not a valid single-line-field CSV. Check the template and try again.",
  headers: "Use exactly the template columns, with no duplicate, missing, or extra columns.",
  rows: "Use one current and one previous row for each included channel, up to three channels.",
  currency: "Use a supported ISO 4217 currency with a defined minor unit from the September 2026 list.",
  values: "Check the window, channel, currency, dates, UTC timestamp, and non-negative whole-number amounts.",
  consistency: "All rows must use one currency and source timestamp, matching channels, and consecutive equal-length periods.",
  freshness: "The source timestamp must be at or after the current period's exclusive end in UTC.",
  totals: "The aggregate totals exceed the supported whole-number range.",
} as const;

const DAY_MS = 86_400_000;
const channels: ReadonlySet<string> = new Set(BUSINESS_SNAPSHOT_CHANNELS);

/** Count UTF-8 bytes without depending on TextEncoder or allocating a copy. */
function exceedsUtf8Limit(text: string, limit: number): boolean {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit <= 0x7f) bytes += 1;
    else if (unit <= 0x7ff) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length
        && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
    if (bytes > limit) return true;
  }
  return false;
}

/** Parse one CSV line, including standard quoted fields, but not multiline fields. */
function parseLine(line: string): string[] | null {
  const fields: string[] = [];
  let field = "";
  let state: "start" | "unquoted" | "quoted" | "afterQuote" = "start";

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (state === "quoted") {
      if (char === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          state = "afterQuote";
        }
      } else {
        field += char;
      }
    } else if (char === ",") {
      fields.push(field);
      field = "";
      state = "start";
    } else if (state === "afterQuote") {
      return null;
    } else if (char === '"') {
      if (state !== "start") return null;
      state = "quoted";
    } else {
      field += char;
      state = "unquoted";
    }
  }
  if (state === "quoted") return null;
  fields.push(field);
  return fields;
}

function dateMillis(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const millis = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(millis) || new Date(millis).toISOString().slice(0, 10) !== value) return null;
  return millis;
}

/** Require an actual ISO UTC instant, including a calendar-valid date. */
function utcTimestamp(value: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  if (!match) return null;
  const expected = `${match[1]}.${(match[2] ?? "").padEnd(3, "0")}Z`;
  const millis = Date.parse(expected);
  if (!Number.isFinite(millis)) return null;
  const canonical = new Date(millis).toISOString();
  return canonical === expected ? canonical : null;
}

function wholeNumber(value: string): number | null {
  if (!/^(0|[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function supportedCurrency(value: string): boolean {
  return businessCurrencyMinorDigits(value) !== null;
}

function addSafe(a: number, b: number): number | null {
  const result = a + b;
  return Number.isSafeInteger(result) ? result : null;
}

/**
 * Parse a bounded, aggregate-only CSV without storing, logging, or transmitting it.
 */
export function parseBusinessSnapshot(text: string): BusinessSnapshotResult {
  if (text.length > BUSINESS_SNAPSHOT_MAX_BYTES || exceedsUtf8Limit(text, BUSINESS_SNAPSHOT_MAX_BYTES)) {
    return { ok: false, error: errors.size };
  }
  const content = text.startsWith("\uFEFF") ? text.slice(1) : text;
  if (content.includes("\0") || /\r(?!\n)/.test(content)) return { ok: false, error: errors.csv };
  const lines = content.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  if (lines.length < 3 || lines.length > 7 || lines.some((line) => line === "")) {
    return { ok: false, error: errors.rows };
  }
  const parsedLines = lines.map(parseLine);
  if (parsedLines.some((line) => line === null)) return { ok: false, error: errors.csv };
  const [header, ...data] = parsedLines as string[][];
  if (header.length !== BUSINESS_SNAPSHOT_HEADERS.length || new Set(header).size !== header.length
      || !BUSINESS_SNAPSHOT_HEADERS.every((name) => header.includes(name))) {
    return { ok: false, error: errors.headers };
  }

  type Header = (typeof BUSINESS_SNAPSHOT_HEADERS)[number];
  const index = Object.fromEntries(header.map((name, i) => [name, i])) as Record<Header, number>;
  const rows: BusinessSnapshotRow[] = [];
  const seen = new Set<string>();
  const periodDates: Partial<Record<BusinessSnapshotPeriodName, { startDate: string; endExclusive: string }>> = {};
  let windowDays: BusinessSnapshotWindow | null = null;
  let currency: string | null = null;
  let sourceUpdatedAt: string | null = null;

  for (const columns of data) {
    if (columns.length !== header.length) return { ok: false, error: errors.csv };
    const get = (name: Header) => columns[index[name]];
    const days = get("window_days");
    const period = get("period");
    const channel = get("channel");
    const rowCurrency = get("currency");
    const startDate = get("start_date");
    const endExclusive = get("end_exclusive");
    const startMillis = dateMillis(startDate);
    const endMillis = dateMillis(endExclusive);
    const timestamp = utcTimestamp(get("source_updated_at"));
    const transactions = wholeNumber(get("transactions"));
    const grossMinor = wholeNumber(get("gross_minor"));
    const refundMinor = wholeNumber(get("refund_minor"));
    if (!supportedCurrency(rowCurrency)) return { ok: false, error: errors.currency };
    if (!(days === "7" || days === "30") || !(period === "previous" || period === "current")
        || !channels.has(channel) || startMillis === null || endMillis === null
        || timestamp === null || transactions === null || grossMinor === null || refundMinor === null
        || transactions > BUSINESS_SNAPSHOT_MAX_TRANSACTIONS_PER_ROW
        || grossMinor > BUSINESS_SNAPSHOT_MAX_MINOR_PER_ROW || refundMinor > BUSINESS_SNAPSHOT_MAX_MINOR_PER_ROW) {
      return { ok: false, error: errors.values };
    }
    const rowWindow = Number(days) as BusinessSnapshotWindow;
    if (endMillis - startMillis !== rowWindow * DAY_MS) return { ok: false, error: errors.consistency };
    if ((windowDays !== null && windowDays !== rowWindow) || (currency !== null && currency !== rowCurrency)
        || (sourceUpdatedAt !== null && sourceUpdatedAt !== timestamp)) {
      return { ok: false, error: errors.consistency };
    }
    const dates = periodDates[period];
    if (dates && (dates.startDate !== startDate || dates.endExclusive !== endExclusive)) {
      return { ok: false, error: errors.consistency };
    }
    const key = `${period}:${channel}`;
    if (seen.has(key)) return { ok: false, error: errors.rows };
    seen.add(key);
    periodDates[period] = { startDate, endExclusive };
    windowDays = rowWindow;
    currency = rowCurrency;
    sourceUpdatedAt = timestamp;
    rows.push({ period, channel: channel as BusinessSnapshotChannel, transactions, grossMinor, refundMinor });
  }

  const previousDates = periodDates.previous;
  const currentDates = periodDates.current;
  if (windowDays === null || currency === null || sourceUpdatedAt === null || !previousDates || !currentDates
      || previousDates.endExclusive !== currentDates.startDate
      || BUSINESS_SNAPSHOT_CHANNELS.some((channel) => seen.has(`previous:${channel}`) !== seen.has(`current:${channel}`))) {
    return { ok: false, error: errors.consistency };
  }
  const currentEndMillis = dateMillis(currentDates.endExclusive);
  if (currentEndMillis === null || Date.parse(sourceUpdatedAt) < currentEndMillis) {
    return { ok: false, error: errors.freshness };
  }

  const periods: Record<BusinessSnapshotPeriodName, BusinessSnapshotPeriod> = {
    previous: { ...previousDates, transactions: 0, grossMinor: 0, refundMinor: 0 },
    current: { ...currentDates, transactions: 0, grossMinor: 0, refundMinor: 0 },
  };
  for (const row of rows) {
    const totals = periods[row.period];
    const transactions = addSafe(totals.transactions, row.transactions);
    const grossMinor = addSafe(totals.grossMinor, row.grossMinor);
    const refundMinor = addSafe(totals.refundMinor, row.refundMinor);
    if (transactions === null || grossMinor === null || refundMinor === null) return { ok: false, error: errors.totals };
    Object.assign(totals, { transactions, grossMinor, refundMinor });
  }

  const { previous, current } = periods;
  return {
    ok: true,
    snapshot: {
      windowDays,
      currency,
      sourceUpdatedAt,
      periods,
      rows,
      summary: {
        transactionChangePct: previous.transactions === 0
          ? null : (current.transactions - previous.transactions) / previous.transactions * 100,
        refundRatioPct: current.grossMinor === 0 ? null : current.refundMinor / current.grossMinor * 100,
      },
    },
  };
}
