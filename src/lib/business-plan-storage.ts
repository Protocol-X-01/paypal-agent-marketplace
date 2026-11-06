export const BUSINESS_PLAN_STORAGE_KEY = "paypal-business-monitoring-plan-v1";

export type Perspective = "teams" | "leadership";
export type IndicatorId = "transactionVolume" | "activityTrend" | "refundShare" | "dataFreshness" | "customerAccounts" | "repeatActivity";
export type ReportingWindow = 7 | 30;

export type IndicatorOption = {
  id: IndicatorId;
  label: string;
  description: string;
  gated?: boolean;
};

export type DraftView = {
  indicators: IndicatorId[];
  windowDays: ReportingWindow;
  activityDropPct: number;
  refundSharePct: number;
};

export type MonitoringPlan = {
  version: 1;
  perspective: Perspective;
  views: Record<Perspective, DraftView>;
};

/** Only the plan, never an imported report, is retained across dashboard sections. */
export type BusinessPlanDraft = { plan: MonitoringPlan; baseline: string | null };

export const indicatorsByPerspective: Record<Perspective, IndicatorOption[]> = {
  teams: [
    { id: "transactionVolume", label: "Payment activity", description: "Included transaction count by period" },
    { id: "refundShare", label: "Refund share", description: "Refund amount relative to gross volume" },
    { id: "dataFreshness", label: "Data freshness", description: "Source update time when available" },
    { id: "customerAccounts", label: "Active customer accounts", description: "Requires an approved customer activity definition and company feed", gated: true },
  ],
  leadership: [
    { id: "activityTrend", label: "Payment activity trend", description: "Included transaction change between periods" },
    { id: "refundShare", label: "Refund share", description: "Refund amount relative to gross volume" },
    { id: "customerAccounts", label: "Active customer accounts", description: "Requires an approved customer activity definition and company feed", gated: true },
    { id: "repeatActivity", label: "Customer retention", description: "Requires an approved identity and cohort definition", gated: true },
  ],
};

export function createDefaultPlan(): MonitoringPlan {
  return {
    version: 1,
    perspective: "teams",
    views: {
      teams: {
        indicators: ["transactionVolume", "refundShare", "dataFreshness"],
        windowDays: 30,
        activityDropPct: 15,
        refundSharePct: 5,
      },
      leadership: {
        indicators: ["activityTrend", "refundShare"],
        windowDays: 30,
        activityDropPct: 15,
        refundSharePct: 5,
      },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).every((key) => keys.includes(key));
}

function parseDraftView(value: unknown, perspective: Perspective): DraftView | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["indicators", "windowDays", "activityDropPct", "refundSharePct"])) return null;
  const allowedIndicators = new Set(
    indicatorsByPerspective[perspective].filter((option) => !option.gated).map((option) => option.id),
  );
  if (
    !Array.isArray(value.indicators) ||
    !value.indicators.every((id): id is IndicatorId => typeof id === "string" && allowedIndicators.has(id as IndicatorId)) ||
    new Set(value.indicators).size !== value.indicators.length ||
    !(value.windowDays === 7 || value.windowDays === 30) ||
    typeof value.activityDropPct !== "number" || !Number.isInteger(value.activityDropPct) ||
    value.activityDropPct < 5 || value.activityDropPct > 50 || value.activityDropPct % 5 !== 0 ||
    typeof value.refundSharePct !== "number" || !Number.isInteger(value.refundSharePct) ||
    value.refundSharePct < 1 || value.refundSharePct > 20
  ) {
    return null;
  }
  return {
    indicators: Array.from(new Set(value.indicators)),
    windowDays: value.windowDays,
    activityDropPct: value.activityDropPct,
    refundSharePct: value.refundSharePct,
  };
}

export function parseMonitoringPlan(serialized: string): MonitoringPlan | null {
  if (serialized.length > 8_000) return null;
  try {
    const value: unknown = JSON.parse(serialized);
    if (
      !isRecord(value) || !hasOnlyKeys(value, ["version", "perspective", "views"]) ||
      value.version !== 1 || !(value.perspective === "teams" || value.perspective === "leadership") ||
      !isRecord(value.views) || !hasOnlyKeys(value.views, ["teams", "leadership"])
    ) {
      return null;
    }
    const teams = parseDraftView(value.views.teams, "teams");
    const leadership = parseDraftView(value.views.leadership, "leadership");
    if (!teams || !leadership) return null;
    return { version: 1, perspective: value.perspective, views: { teams, leadership } };
  } catch {
    return null;
  }
}

type PlanStorage = Pick<Storage, "getItem" | "setItem">;

export type BusinessPlanRead =
  | { kind: "missing"; baseline: null }
  | { kind: "valid"; baseline: string; plan: MonitoringPlan }
  | { kind: "unreadable" }
  | { kind: "unavailable" };

export type BusinessPlanStorageState = "loading" | "ready" | "conflict" | "unreadable" | "unavailable";

/** Decide whether another tab's change may replace the current screen. */
export function assessExternalBusinessPlan(
  result: BusinessPlanRead,
  baseline: string | null,
  pending: boolean,
  reset: boolean,
  state: BusinessPlanStorageState,
): "unreadable" | "unavailable" | "conflict" | "load" | "ignore" {
  if (result.kind === "unreadable" || result.kind === "unavailable") return result.kind;
  if (pending && (reset || result.baseline !== baseline || state === "conflict")) return "conflict";
  if (!pending && (reset || result.baseline !== baseline || state !== "ready")) return "load";
  return "ignore";
}

/** Read without repairing, logging, or overwriting an unknown stored value. */
export function readBusinessPlan(storage: PlanStorage): BusinessPlanRead {
  let raw: string | null;
  try { raw = storage.getItem(BUSINESS_PLAN_STORAGE_KEY); }
  catch { return { kind: "unavailable" }; }
  if (raw === null) return { kind: "missing", baseline: null };
  const plan = parseMonitoringPlan(raw);
  return plan ? { kind: "valid", baseline: raw, plan } : { kind: "unreadable" };
}

export type BusinessPlanWrite =
  | { kind: "saved"; baseline: string }
  | { kind: "changed" }
  | { kind: "unreadable" }
  | { kind: "unavailable" };

/** A fresh-read guard detects ordinary stale tabs; localStorage writes are not atomic. */
export function saveBusinessPlan(storage: PlanStorage, baseline: string | null, plan: MonitoringPlan): BusinessPlanWrite {
  const current = readBusinessPlan(storage);
  if (current.kind === "unavailable" || current.kind === "unreadable") return current;
  if (current.baseline !== baseline) return { kind: "changed" };
  const encoded = JSON.stringify(plan);
  try { if (current.baseline !== encoded) storage.setItem(BUSINESS_PLAN_STORAGE_KEY, encoded); }
  catch { return { kind: "unavailable" }; }
  return { kind: "saved", baseline: encoded };
}
