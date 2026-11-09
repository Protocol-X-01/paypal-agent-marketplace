// Keep this pure calculation in sync with src/lib/business-thresholds.ts.
export const DEFAULT_BUSINESS_THRESHOLDS = Object.freeze({ activityDropPct: 15, refundSharePct: 5 });
export const MIN_REFUND_THRESHOLD_PCT = 1;
export const MAX_REFUND_THRESHOLD_PCT = 1_000;

export type BusinessThresholds = Readonly<{
  activityDropPct: number;
  refundSharePct: number;
}>;

export type BusinessThresholdStatus = "unavailable" | "clear" | "notice";

export type BusinessThresholdResult = Readonly<{
  status: BusinessThresholdStatus;
  observedPct: number | null;
  thresholdPct: number;
}>;

export type BusinessThresholdEvaluation = Readonly<{
  activityDrop: BusinessThresholdResult;
  refundShare: BusinessThresholdResult;
}>;

export function isValidBusinessThresholds(value: unknown): value is BusinessThresholds {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const fields = value as Record<string, unknown>;
  return Object.keys(fields).length === 2
    && Object.prototype.hasOwnProperty.call(fields, "activityDropPct")
    && Object.prototype.hasOwnProperty.call(fields, "refundSharePct")
    && Number.isInteger(fields.activityDropPct)
    && Number(fields.activityDropPct) >= 5
    && Number(fields.activityDropPct) <= 50
    && Number(fields.activityDropPct) % 5 === 0
    && Number.isInteger(fields.refundSharePct)
    && Number(fields.refundSharePct) >= MIN_REFUND_THRESHOLD_PCT
    && Number(fields.refundSharePct) <= MAX_REFUND_THRESHOLD_PCT;
}

export function parseBusinessThresholds(serialized: string): BusinessThresholds | null {
  if (serialized.length > 128) return null;
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (Object.keys(record).length !== 3 || record.version !== 1) return null;
    return isValidBusinessThresholds({ activityDropPct: record.activityDropPct, refundSharePct: record.refundSharePct })
      ? { activityDropPct: record.activityDropPct as number, refundSharePct: record.refundSharePct as number }
      : null;
  } catch {
    return null;
  }
}

export function encodeBusinessThresholds(value: BusinessThresholds): string | null {
  if (!isValidBusinessThresholds(value)) return null;
  const serialized = JSON.stringify({ version: 1, ...value });
  return serialized.length <= 128 ? serialized : null;
}

export function adjustBusinessThreshold(
  current: BusinessThresholds,
  field: keyof BusinessThresholds,
  direction: -1 | 1,
): BusinessThresholds {
  const step = 5;
  const minimum = field === "activityDropPct" ? 5 : MIN_REFUND_THRESHOLD_PCT;
  const maximum = field === "activityDropPct" ? 50 : MAX_REFUND_THRESHOLD_PCT;
  return {
    ...current,
    [field]: Math.max(minimum, Math.min(maximum, current[field] + direction * step)),
  };
}

/** Compare only aggregate report metrics. A missing denominator stays unavailable. */
export function evaluateBusinessThresholds(
  summary: { transactionChangePct: number | null; refundRatioPct: number | null },
  thresholds: BusinessThresholds,
): BusinessThresholdEvaluation {
  const activity = summary.transactionChangePct;
  const refunds = summary.refundRatioPct;
  return {
    activityDrop: {
      status: activity === null || !Number.isFinite(activity)
        ? "unavailable"
        : activity <= -thresholds.activityDropPct ? "notice" : "clear",
      observedPct: activity,
      thresholdPct: thresholds.activityDropPct,
    },
    refundShare: {
      status: refunds === null || !Number.isFinite(refunds)
        ? "unavailable"
        : refunds >= thresholds.refundSharePct ? "notice" : "clear",
      observedPct: refunds,
      thresholdPct: thresholds.refundSharePct,
    },
  };
}
