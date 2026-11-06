/**
 * A bounded, browser-only reader for a narrow subset of a user-selected
 * PayPal Activity Download CSV. The input can contain personal information;
 * output and errors contain only fixed messages, dates, and aggregate counts.
 * No row, identifier, filename, or other field value is returned.
 */
export const PAYPAL_ACTIVITY_MAX_BYTES = 4 * 1024 * 1024;
export const PAYPAL_ACTIVITY_MAX_ROWS = 50_000;
const MAX_COLUMNS = 100;
const MAX_FIELD_LENGTH = 8192;
const DAY_MS = 86_400_000;

const requiredHeaders = [
  "date", "time", "timezone", "status", "transaction event code", "balance impact", "transaction id",
] as const;
type Header = (typeof requiredHeaders)[number];
type Row = Record<Header, string>;

const statuses = new Set([
  "completed", "denied", "reversed", "pending", "active", "expired", "removed", "unverified", "voided",
  "processing", "processed", "created", "canceled", "cancelled", "error", "masspaymentsent", "draft",
  "unpaid", "paid", "unpaid (sent)", "marked as paid", "marked as refunded", "refunded",
  "partially refunded", "scheduled", "partially paid", "payment pending",
]);

type ErrorCode = "options" | "size" | "csv" | "headers" | "rows" | "coverage" | "date" | "timezone" | "status" | "event" | "identity";
const messages: Record<ErrorCode, string> = {
  options: "Choose a date format, two complete periods, and confirm coverage before selecting the file.",
  size: "The file is too large. Choose one CSV of at most 4 MiB.",
  csv: "The file is not a supported UTF-8 CSV. Check the report and try again.",
  headers: "Required report columns are missing or duplicated. Include Date, Time, TimeZone, Status, Transaction Event Code, Balance Impact, and Transaction ID.",
  rows: "The file has no activity rows, too many rows, or an unsupported row shape.",
  coverage: "No rows were found in one selected period. Check that the export covers both complete periods.",
  date: "A date or time is invalid for the selected format. Use a complete UTC/GMT export.",
  timezone: "Only rows explicitly marked UTC or GMT are supported in this preview.",
  status: "This preview supports English PayPal status and balance-impact values only.",
  event: "A transaction event code is missing or unsupported in format.",
  identity: "Transaction IDs are missing, invalid, or repeated. Reconcile the export before using this preview.",
};

export type PayPalActivityOptions = {
  dateOrder: "dmy" | "mdy";
  windowDays: 7 | 30;
  endExclusive: string;
  coverageConfirmed: boolean;
  /** Injected by the caller so a current/unfinished UTC period can be rejected. */
  nowMs: number;
};

export type PayPalActivityPeriod = {
  startDate: string;
  endExclusive: string;
  included: number;
  otherEvent: number;
  notCompleted: number;
  notCredit: number;
};

export type PayPalActivitySummary = {
  windowDays: 7 | 30;
  previous: PayPalActivityPeriod;
  current: PayPalActivityPeriod;
  rowsInFile: number;
  outsidePeriods: number;
  changePct: number | null;
};

export type PayPalActivityResult =
  | { ok: true; summary: PayPalActivitySummary }
  | { ok: false; error: string };

class ParseError extends Error {
  constructor(readonly code: ErrorCode) { super(code); }
}
function fail(code: ErrorCode): never { throw new ParseError(code); }

function dateOf(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const year = Number(value.slice(0, 4));
  if (year < 1900) return null;
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value ? ms : null;
}

function utcTimestamp(date: string, time: string, order: "dmy" | "mdy"): number | null {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(date);
  const clock = /^(\d{2}):(\d{2}):(\d{2})$/.exec(time);
  if (!match || !clock) return null;
  const first = Number(match[1]);
  const second = Number(match[2]);
  const month = order === "dmy" ? second : first;
  const day = order === "dmy" ? first : second;
  const year = Number(match[3]);
  const hour = Number(clock[1]);
  const minute = Number(clock[2]);
  const secondOfMinute = Number(clock[3]);
  if (year < 1900 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || secondOfMinute > 59) return null;
  const ms = Date.UTC(year, month - 1, day, hour, minute, secondOfMinute);
  const d = new Date(ms);
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? ms : null;
}

/**
 * Parse standard CSV with quoted commas/newlines. Once the header is known,
 * only the seven required fields are copied out of each row. Other fields,
 * including names, emails and notes, are never included in the result.
 */
function visitRows(text: string, visit: (row: Row) => void): number {
  let state: "start" | "plain" | "quoted" | "closed" = "start";
  let field = "";
  let fieldLength = 0;
  let column = 0;
  let header: string[] | null = null;
  let selected: Map<number, Header> | null = null;
  let headerFields: string[] = [];
  let values: Partial<Row> = {};
  let rows = 0;
  let rowHasData = false;

  const append = (char: string) => {
    fieldLength += char.length;
    if (fieldLength > MAX_FIELD_LENGTH) fail("csv");
    if (header === null || selected?.has(column)) field += char;
  };
  const endField = () => {
    if (column >= MAX_COLUMNS) fail("csv");
    if (header === null) headerFields.push(field);
    else {
      const key = selected?.get(column);
      if (key) values[key] = field.trim();
    }
    field = "";
    fieldLength = 0;
    column += 1;
    state = "start";
  };
  const endRow = () => {
    if (header === null) {
      const names = headerFields.map((value) => value.trim().toLowerCase());
      if (new Set(names).size !== names.length || requiredHeaders.some((name) => !names.includes(name))) fail("headers");
      header = names;
      selected = new Map(requiredHeaders.map((name) => [names.indexOf(name), name]));
      headerFields = [];
    } else {
      if (!rowHasData || column !== header.length) fail("rows");
      rows += 1;
      if (rows > PAYPAL_ACTIVITY_MAX_ROWS) fail("rows");
      if (requiredHeaders.some((key) => typeof values[key] !== "string")) fail("rows");
      visit(values as Row);
    }
    column = 0;
    values = {};
    rowHasData = false;
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === "\0") fail("csv");
    if (state === "quoted") {
      if (char === '"') {
        if (text[i + 1] === '"') { append('"'); i += 1; }
        else state = "closed";
      } else append(char);
      rowHasData = true;
      continue;
    }
    if (char === ",") { endField(); rowHasData = true; continue; }
    if (char === "\n" || char === "\r") {
      if (char === "\r") {
        if (text[i + 1] !== "\n") fail("csv");
        i += 1;
      }
      endField();
      endRow();
      continue;
    }
    if (state === "closed") fail("csv");
    if (char === '"') {
      if (state !== "start") fail("csv");
      state = "quoted";
    } else {
      append(char);
      state = "plain";
    }
    rowHasData = true;
  }
  if (state === "quoted") fail("csv");
  if (rowHasData || column > 0) { endField(); endRow(); }
  if (header === null || rows === 0) fail("rows");
  return rows;
}

/** Parse an opted-in export, without storing, logging, or transmitting it. */
export function summarizePayPalActivity(text: string, options: PayPalActivityOptions): PayPalActivityResult {
  try {
    if (!options || options.coverageConfirmed !== true || !["dmy", "mdy"].includes(options.dateOrder)
        || ![7, 30].includes(options.windowDays) || !Number.isFinite(options.nowMs)) fail("options");
    const end = dateOf(options.endExclusive);
    if (end === null) fail("options");
    const now = new Date(options.nowMs);
    if (!Number.isFinite(now.getTime())) fail("options");
    const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    if (end > todayUtc) fail("options");
    const currentStart = end - options.windowDays * DAY_MS;
    const previousStart = currentStart - options.windowDays * DAY_MS;
    if (new Date(previousStart).getUTCFullYear() < 1900) fail("options");
    if (typeof text !== "string" || text.length > PAYPAL_ACTIVITY_MAX_BYTES
        || new TextEncoder().encode(text).byteLength > PAYPAL_ACTIVITY_MAX_BYTES) fail("size");

    const period = (start: number, finish: number): PayPalActivityPeriod => ({
      startDate: new Date(start).toISOString().slice(0, 10),
      endExclusive: new Date(finish).toISOString().slice(0, 10),
      included: 0, otherEvent: 0, notCompleted: 0, notCredit: 0,
    });
    const previous = period(previousStart, currentStart);
    const current = period(currentStart, end);
    const ids = new Set<string>();
    let outsidePeriods = 0;
    const content = text.startsWith("\uFEFF") ? text.slice(1) : text;
    const rowsInFile = visitRows(content, (row) => {
      if (row.timezone !== "UTC" && row.timezone !== "GMT") fail("timezone");
      const timestamp = utcTimestamp(row.date, row.time, options.dateOrder);
      if (timestamp === null) fail("date");
      const status = row.status.toLowerCase();
      const impact = row["balance impact"].toLowerCase();
      if (!statuses.has(status) || !["credit", "debit", "memo"].includes(impact)) fail("status");
      const code = row["transaction event code"];
      if (!/^T\d{4}$/.test(code)) fail("event");
      const id = row["transaction id"];
      if (!/^[A-Za-z0-9]{17}$/.test(id) || ids.has(id.toUpperCase())) fail("identity");
      ids.add(id.toUpperCase());
      const target = timestamp >= previousStart && timestamp < currentStart ? previous
        : timestamp >= currentStart && timestamp < end ? current : null;
      if (!target) { outsidePeriods += 1; return; }
      if (status !== "completed") target.notCompleted += 1;
      else if (code !== "T0006" && code !== "T0007") target.otherEvent += 1;
      else if (impact !== "credit") target.notCredit += 1;
      else target.included += 1;
    });
    const periodRows = (value: PayPalActivityPeriod) => value.included + value.otherEvent + value.notCompleted + value.notCredit;
    if (periodRows(previous) === 0 || periodRows(current) === 0) fail("coverage");
    const changePct = previous.included === 0 ? null : (current.included - previous.included) / previous.included * 100;
    return { ok: true, summary: { windowDays: options.windowDays, previous, current, rowsInFile, outsidePeriods, changePct } };
  } catch (error) {
    return { ok: false, error: messages[error instanceof ParseError ? error.code : "csv"] };
  }
}
