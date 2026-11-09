export type PeriodDays = 7 | 30;
export type AccountType = "Personal" | "Business";
export type Market = "US" | "UK" | "Other";
export type CohortAge = "Existing" | "New";
export type AccountFilter = "All" | AccountType;
export type MarketFilter = "All" | Market;

export type AggregateRow = {
  id: string;
  accountType: AccountType;
  market: Market;
  age: CohortAge;
  priorActive: number;
  currentActive: number;
  retained: number;
  priorAttempted: number;
  priorCompleted: number;
  currentAttempted: number;
  currentCompleted: number;
  priorGrossMinor: number;
  currentGrossMinor: number;
};

export type AggregateSummary = {
  priorActive: number;
  currentActive: number;
  retained: number;
  reactivated: number;
  newlyActive: number;
  noLongerActive: number;
  priorAttempted: number;
  priorCompleted: number;
  currentAttempted: number;
  currentCompleted: number;
  priorGrossMinor: number;
  currentGrossMinor: number;
  retention: number | null;
  priorCompletion: number | null;
  completion: number | null;
  completionChangePoints: number | null;
  fixtureEventCohorts: readonly Pick<AggregateRow, "priorCompleted" | "currentCompleted">[];
};

export type FictionalPeriod = {
  days: PeriodDays;
  currentStart: string;
  currentEnd: string;
  priorStart: string;
  priorEnd: string;
  fixtureTimestamp: string;
  rows: readonly AggregateRow[];
};

export type SortKey = "cohort" | "currentActive" | "currentCompleted" | "retention" | "completion";
export type SortDirection = "ascending" | "descending";

const DAY_MS = 86_400_000;
const numericFields = [
  "priorActive", "currentActive", "retained", "priorAttempted", "priorCompleted",
  "currentAttempted", "currentCompleted", "priorGrossMinor", "currentGrossMinor",
] as const;

type BaseRow = Omit<AggregateRow, "id" | "market">;

// These are invented, independent reporting populations for two example periods.
// In particular, unique active-account counts are not scaled from daily counts.
const weekly: readonly BaseRow[] = [
  { accountType: "Personal", age: "Existing", priorActive: 42_000, currentActive: 43_200, retained: 36_000, priorAttempted: 180_000, priorCompleted: 170_000, currentAttempted: 190_000, currentCompleted: 182_400, priorGrossMinor: 742_000_000, currentGrossMinor: 782_400_000 },
  { accountType: "Personal", age: "New", priorActive: 0, currentActive: 6_500, retained: 0, priorAttempted: 0, priorCompleted: 0, currentAttempted: 9_400, currentCompleted: 8_742, priorGrossMinor: 0, currentGrossMinor: 69_400_000 },
  { accountType: "Business", age: "Existing", priorActive: 18_000, currentActive: 18_700, retained: 15_600, priorAttempted: 110_000, priorCompleted: 105_600, currentAttempted: 120_000, currentCompleted: 116_640, priorGrossMinor: 2_340_000_000, currentGrossMinor: 2_482_000_000 },
  { accountType: "Business", age: "New", priorActive: 0, currentActive: 2_100, retained: 0, priorAttempted: 0, priorCompleted: 0, currentAttempted: 9_600, currentCompleted: 9_120, priorGrossMinor: 0, currentGrossMinor: 181_000_000 },
];

const monthly: readonly BaseRow[] = [
  { accountType: "Personal", age: "Existing", priorActive: 92_000, currentActive: 98_800, retained: 78_200, priorAttempted: 760_000, priorCompleted: 720_000, currentAttempted: 820_000, currentCompleted: 787_200, priorGrossMinor: 3_200_000_000, currentGrossMinor: 3_600_000_000 },
  { accountType: "Personal", age: "New", priorActive: 0, currentActive: 16_000, retained: 0, priorAttempted: 0, priorCompleted: 0, currentAttempted: 29_000, currentCompleted: 26_970, priorGrossMinor: 0, currentGrossMinor: 219_000_000 },
  { accountType: "Business", age: "Existing", priorActive: 38_000, currentActive: 42_100, retained: 33_440, priorAttempted: 460_000, priorCompleted: 446_200, currentAttempted: 510_000, currentCompleted: 496_230, priorGrossMinor: 9_700_000_000, currentGrossMinor: 10_300_000_000 },
  { accountType: "Business", age: "New", priorActive: 0, currentActive: 6_400, retained: 0, priorAttempted: 0, priorCompleted: 0, currentAttempted: 31_000, currentCompleted: 29_760, priorGrossMinor: 0, currentGrossMinor: 542_000_000 },
];

function splitMarkets(baseRows: readonly BaseRow[]): readonly AggregateRow[] {
  const markets: readonly Market[] = ["US", "UK", "Other"];
  return baseRows.flatMap((base) => {
    const parts = markets.map((market) => ({ ...base, market, id: `${base.accountType.toLowerCase()}-${base.age.toLowerCase()}-${market.toLowerCase()}` }));
    for (const field of numericFields) {
      parts[0][field] = Math.floor(base[field] * 0.5);
      parts[1][field] = Math.floor(base[field] * 0.3);
      parts[2][field] = base[field] - parts[0][field] - parts[1][field];
    }
    return parts;
  });
}

const fixtureRows = { 7: splitMarkets(weekly), 30: splitMarkets(monthly) } as const;

export function getFictionalPeriod(days: PeriodDays): FictionalPeriod {
  const end = Date.UTC(2026, 10, 2);
  const start = end - days * DAY_MS;
  return {
    days,
    currentStart: new Date(start).toISOString(),
    currentEnd: new Date(end).toISOString(),
    priorStart: new Date(start - days * DAY_MS).toISOString(),
    priorEnd: new Date(start).toISOString(),
    fixtureTimestamp: "2026-11-02T00:35:00.000Z",
    rows: fixtureRows[days],
  };
}

export function filterAggregates(rows: readonly AggregateRow[], accountType: AccountFilter, market: MarketFilter): AggregateRow[] {
  return rows.filter((row) => (accountType === "All" || row.accountType === accountType) && (market === "All" || row.market === market));
}

export function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

export function summarize(rows: readonly AggregateRow[]): AggregateSummary {
  const sum = (field: typeof numericFields[number]) => rows.reduce((total, row) => total + row[field], 0);
  const priorActive = sum("priorActive");
  const currentActive = sum("currentActive");
  const retained = sum("retained");
  const newlyActive = rows.filter((row) => row.age === "New").reduce((total, row) => total + row.currentActive, 0);
  const priorAttempted = sum("priorAttempted");
  const priorCompleted = sum("priorCompleted");
  const currentAttempted = sum("currentAttempted");
  const currentCompleted = sum("currentCompleted");
  const priorCompletion = ratio(priorCompleted, priorAttempted);
  const completion = ratio(currentCompleted, currentAttempted);
  return {
    priorActive, currentActive, retained, newlyActive,
    reactivated: currentActive - retained - newlyActive,
    noLongerActive: priorActive - retained,
    priorAttempted, priorCompleted, currentAttempted, currentCompleted,
    priorGrossMinor: sum("priorGrossMinor"), currentGrossMinor: sum("currentGrossMinor"),
    retention: ratio(retained, priorActive),
    priorCompletion, completion,
    completionChangePoints: priorCompletion === null || completion === null ? null : (completion - priorCompletion) * 100,
    fixtureEventCohorts: rows.map(({ priorCompleted, currentCompleted }) => ({ priorCompleted, currentCompleted })),
  };
}

export function cohortName(row: AggregateRow): string {
  return `${row.accountType} · ${row.age.toLowerCase()} · ${row.market}`;
}

export function tableRows(rows: readonly AggregateRow[], query: string, sort: SortKey, direction: SortDirection): AggregateRow[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter((term) => term !== "" && term !== "·");
  const selected = rows.filter((row) => {
    const label = cohortName(row).toLowerCase();
    return terms.every((term) => {
      // A market code should match the market, rather than "us" inside "business".
      if (term === "us" || term === "uk") return row.market.toLowerCase() === term;
      return label.includes(term);
    });
  });
  const value = (row: AggregateRow): number | string | null => {
    if (sort === "cohort") return cohortName(row);
    if (sort === "retention") return ratio(row.retained, row.priorActive);
    if (sort === "completion") return ratio(row.currentCompleted, row.currentAttempted);
    return row[sort];
  };
  return selected.sort((a, b) => {
    const left = value(a);
    const right = value(b);
    // Missing ratios belong last in either sort direction.
    if (left === null || right === null) return left === right ? a.id.localeCompare(b.id) : left === null ? 1 : -1;
    const order = typeof left === "string" && typeof right === "string" ? left.localeCompare(right) : Number(left) - Number(right);
    return (direction === "ascending" ? order : -order) || a.id.localeCompare(b.id);
  });
}

function distribute(total: number, days: PeriodDays, phase: number): number[] {
  const pattern = [88, 101, 97, 112, 121, 95, 86];
  const weights = Array.from({ length: days }, (_, i) => pattern[(i + phase) % pattern.length] + Math.floor(i / 7) * 3);
  const weightTotal = weights.reduce((a, b) => a + b, 0);
  const values = weights.map((weight) => Math.floor(total * weight / weightTotal));
  const remainder = total - values.reduce((a, b) => a + b, 0);
  for (let i = 0; i < remainder; i++) values[i % days] += 1;
  return values;
}

export function fictionalDailyEvents(summary: AggregateSummary, days: PeriodDays): { day: number; current: number; prior: number }[] {
  // Distribute each disjoint fixture cohort before summing, so every filtered
  // view is a consistent partition of the same invented daily events.
  const daily = Array.from({ length: days }, (_, i) => ({ day: i + 1, current: 0, prior: 0 }));
  for (const cohort of summary.fixtureEventCohorts) {
    const current = distribute(cohort.currentCompleted, days, 0);
    const prior = distribute(cohort.priorCompleted, days, 2);
    for (let i = 0; i < days; i++) {
      daily[i].current += current[i];
      daily[i].prior += prior[i];
    }
  }
  return daily;
}

export function percentChange(current: number, prior: number): number | null {
  return prior > 0 ? (current - prior) / prior : null;
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatPercent(value: number | null): string {
  return value === null ? "Unavailable" : new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 }).format(value);
}

export function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(value));
}

export function formatPeriod(start: string, endExclusive: string): string {
  return `${formatDate(start)} – ${formatDate(new Date(Date.parse(endExclusive) - DAY_MS).toISOString())}`;
}
