export interface ChartDomain {
  min: number;
  max: number;
}

/** Sort a copy by time; equal timestamps retain their provider order. */
export function chronologicalChartPoints<T extends { timestamp: number }>(points: readonly T[]): T[] {
  return points
    .map((point, index) => ({ point, index }))
    .sort((left, right) => left.point.timestamp - right.point.timestamp || left.index - right.index)
    .map(({ point }) => point);
}

/** A percentage across one instant is not a period change. */
export function chartPercentageChange(points: readonly { timestamp: number; value: number }[]): number | null {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last || !Number.isFinite(first.timestamp) || !Number.isFinite(last.timestamp)
      || first.timestamp >= last.timestamp || !Number.isFinite(first.value) || !Number.isFinite(last.value) || first.value === 0) return null;
  const change = (last.value / first.value - 1) * 100;
  return Number.isFinite(change) ? change : null;
}

/** Give the visible observations breathing room without forcing the axis to zero. */
export function visibleChartDomain(values: readonly number[], includeUsdPeg = false): ChartDomain | null {
  const finiteValues = values.filter(Number.isFinite);
  if (!finiteValues.length) return null;

  let min = Math.min(...finiteValues);
  let max = Math.max(...finiteValues);
  if (includeUsdPeg) {
    min = Math.min(min, 0.98);
    max = Math.max(max, 1.02);
  }
  if (min === 0 && max === 0) return { min: 0, max: 1 };

  const padding = Math.max((max - min) * 0.12, Math.max(Math.abs(min), Math.abs(max)) * 0.005, Number.EPSILON);
  const lower = min >= 0 ? Math.max(0, min - padding) : min - padding;
  const upper = max + padding;
  return Number.isFinite(lower) && Number.isFinite(upper) && upper > lower ? { min: lower, max: upper } : null;
}
