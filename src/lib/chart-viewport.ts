export type ChartViewport = { start: number; end: number };
export type ChartViewportAction = "in" | "out" | "earlier" | "later" | "reset";
export const FULL_CHART_VIEWPORT: ChartViewport = { start: 0, end: 1 };
export const VIEWPORT_EPSILON = 1e-9;

/** Keep at least three observations visible without imposing a fixed 4× limit. */
export function minimumChartViewportSpan(pointCount: number): number {
  return pointCount < 4 ? 1 : Math.min(1, 2 / (pointCount - 1));
}

export function chartViewportAction(viewport: ChartViewport, action: Exclude<ChartViewportAction, "reset">, pointCount: number): ChartViewport {
  const minimumSpan = minimumChartViewportSpan(pointCount);
  // A refreshed series may have fewer observations than the one being viewed.
  const span = Math.max(minimumSpan, Math.min(1, viewport.end - viewport.start));
  const center = (viewport.start + viewport.end) / 2;
  const normalizedStart = Math.max(0, Math.min(1 - span, center - span / 2));
  if (action === "in" || action === "out") {
    const nextSpan = action === "in" ? Math.max(minimumSpan, span / 2) : Math.min(1, span * 2);
    if (Math.abs(nextSpan - (viewport.end - viewport.start)) < VIEWPORT_EPSILON) return viewport;
    const desiredStart = action === "in" ? normalizedStart + span - nextSpan : normalizedStart + span / 2 - nextSpan / 2;
    const start = Math.max(0, Math.min(1 - nextSpan, desiredStart));
    return { start, end: start + nextSpan };
  }
  const shift = span * 0.5 * (action === "earlier" ? -1 : 1);
  const start = Math.max(0, Math.min(1 - span, normalizedStart + shift));
  return { start, end: start + span };
}

/** Window by sample order while retaining neighboring observations. */
export function visibleChartPoints<T>(points: T[], viewport: ChartViewport): T[] {
  if (points.length < 4 || (viewport.start === 0 && viewport.end === 1)) return points;
  const first = Math.max(0, Math.min(points.length - 3, Math.floor(viewport.start * (points.length - 1) + VIEWPORT_EPSILON)));
  const end = Math.min(points.length, Math.max(first + 3, Math.ceil(viewport.end * (points.length - 1) - VIEWPORT_EPSILON) + 1));
  return points.slice(first, end);
}

/** Pointer-centered zoom chooses a contiguous real-sample window by actual time. */
export function chartViewportWheelZoom(points: readonly { timestamp: number }[], viewport: ChartViewport, factor: number, pointerRatio: number): ChartViewport {
  if (points.length < 4 || !Number.isFinite(factor) || factor <= 0 || !Number.isFinite(pointerRatio)) return viewport;
  const count = points.length;
  const first = Math.max(0, Math.min(count - 3, Math.floor(viewport.start * (count - 1) + VIEWPORT_EPSILON)));
  const end = Math.min(count, Math.max(first + 3, Math.ceil(viewport.end * (count - 1) - VIEWPORT_EPSILON) + 1));
  const nextCount = Math.max(3, Math.min(count, Math.round((end - first) * factor)));
  if (nextCount === end - first) return viewport;
  const ratio = Math.max(0, Math.min(1, pointerRatio));
  const firstTime = points[first].timestamp;
  const lastTime = points[end - 1].timestamp;
  if (!Number.isFinite(firstTime) || !Number.isFinite(lastTime) || firstTime >= lastTime) return viewport;
  const anchorTime = firstTime + ratio * (lastTime - firstTime);
  let bestStart = -1;
  let bestError = Infinity;
  for (let start = 0; start + nextCount <= count; start++) {
    const left = points[start].timestamp;
    const right = points[start + nextCount - 1].timestamp;
    if (!Number.isFinite(left) || !Number.isFinite(right) || left >= right || anchorTime < left || anchorTime > right) continue;
    const error = Math.abs(left + ratio * (right - left) - anchorTime);
    if (error < bestError) { bestStart = start; bestError = error; }
  }
  if (bestStart < 0) return viewport;
  if (nextCount === count) return FULL_CHART_VIEWPORT;
  return { start: bestStart / (count - 1), end: (bestStart + nextCount - 1) / (count - 1) };
}

/** Describe zoom by the actual time between the plotted endpoints. */
export function chartZoomLabel(points: readonly { timestamp: number }[], visiblePoints: readonly { timestamp: number }[]): string {
  const fullTime = (points[points.length - 1]?.timestamp ?? 0) - (points[0]?.timestamp ?? 0);
  const visibleTime = (visiblePoints[visiblePoints.length - 1]?.timestamp ?? 0) - (visiblePoints[0]?.timestamp ?? 0);
  const ratio = fullTime / visibleTime;
  return fullTime > 0 && visibleTime > 0 && Number.isFinite(ratio) ? `${ratio.toFixed(1)}× view` : "View range unavailable";
}
