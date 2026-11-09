import type { ChartPoint } from './market';

export const CHART_WIDTH = 640;
export const CHART_HEIGHT = 228;
export const CHART_PAD_X = 16;
export const CHART_PAD_Y = 18;
const MAX_SAMPLED_POINTS = 120;

export interface ChartReference {
  value: number;
  minDomain: number;
  maxDomain: number;
}

/** A point actually retained in the drawn line, not an interpolated price. */
export interface PlottedChartSample extends ChartPoint {
  x: number;
  y: number;
}

/** Pick by horizontal plot position, which also handles irregular sample times. */
export function nearestPlottedSampleIndex(samples: readonly Pick<PlottedChartSample, 'x'>[], x: number): number | null {
  if (!samples.length || !Number.isFinite(x)) return null;
  let best = 0;
  let bestDistance = Math.abs(samples[0]!.x - x);
  for (let index = 1; index < samples.length; index += 1) {
    const distance = Math.abs(samples[index]!.x - x);
    // In an exact tie, prefer the later sample. Duplicate times remain
    // separately reachable with the previous/next controls.
    if (distance <= bestDistance) { best = index; bestDistance = distance; }
  }
  return best;
}

export function buildChartPath(points: ChartPoint[], reference?: ChartReference, overlayValues: readonly number[] = []) {
  const safePoints = points
    .filter((point) => Number.isFinite(point.value) && Number.isFinite(point.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp);
  if (safePoints.length < 2) {
    return { line: '', area: '', samples: [] as PlottedChartSample[], last: null as { x: number; y: number } | null, first: null as ChartPoint | null, lastPoint: null as ChartPoint | null, low: null as number | null, high: null as number | null, domainLow: null as number | null, domainHigh: null as number | null, referenceY: null as number | null };
  }

  let low = safePoints[0]!.value;
  let high = low;
  let lowIndex = 0;
  let highIndex = 0;
  safePoints.forEach((point, index) => {
    if (point.value < low) { low = point.value; lowIndex = index; }
    if (point.value > high) { high = point.value; highIndex = index; }
  });

  const lastIndex = safePoints.length - 1;
  let sampled = safePoints;
  if (safePoints.length > MAX_SAMPLED_POINTS) {
    const indices = new Set([0, lastIndex, lowIndex, highIndex]);
    const uniformSlots = MAX_SAMPLED_POINTS - 4;
    for (let slot = 1; slot <= uniformSlots; slot += 1) {
      indices.add(Math.round((slot * lastIndex) / (uniformSlots + 1)));
    }
    sampled = [...indices].sort((a, b) => a - b).map((index) => safePoints[index]!);
  }

  const first = safePoints[0]!;
  const lastPoint = safePoints[lastIndex]!;
  const timeSpan = lastPoint.timestamp - first.timestamp;
  const validReference = reference && Number.isFinite(reference.value) && Number.isFinite(reference.minDomain) && Number.isFinite(reference.maxDomain) && reference.minDomain <= reference.value && reference.value <= reference.maxDomain && reference.minDomain < reference.maxDomain ? reference : null;
  let domainLow = validReference ? Math.min(low, validReference.minDomain) : low;
  let domainHigh = validReference ? Math.max(high, validReference.maxDomain) : high;
  for (const value of overlayValues) {
    if (!Number.isFinite(value)) continue;
    domainLow = Math.min(domainLow, value);
    domainHigh = Math.max(domainHigh, value);
  }
  const valueSpan = domainHigh - domainLow;
  const plotWidth = CHART_WIDTH - CHART_PAD_X * 2;
  const plotHeight = CHART_HEIGHT - CHART_PAD_Y * 2;
  const valueScale = Math.max(Math.abs(domainLow), Math.abs(domainHigh), Number.MIN_VALUE);
  const normalizedValueSpan = domainHigh / valueScale - domainLow / valueScale;
  const yPosition = (value: number) => valueSpan > 0
    ? CHART_PAD_Y + (Number.isFinite(valueSpan)
      ? (domainHigh - value) / valueSpan
      : (domainHigh / valueScale - value / valueScale) / normalizedValueSpan) * plotHeight
    : CHART_PAD_Y + plotHeight / 2;
  const timeScale = Math.max(Math.abs(first.timestamp), Math.abs(lastPoint.timestamp), Number.MIN_VALUE);
  const normalizedTimeSpan = lastPoint.timestamp / timeScale - first.timestamp / timeScale;
  const timePosition = (timestamp: number, index: number) => timeSpan > 0
    ? (Number.isFinite(timeSpan)
      ? (timestamp - first.timestamp) / timeSpan
      : (timestamp / timeScale - first.timestamp / timeScale) / normalizedTimeSpan)
    : index / Math.max(sampled.length - 1, 1);
  const coordinates = sampled.map((point, index) => ({
    ...point,
    // Use the same rounded coordinates as the SVG path so the marker sits on
    // the rendered sample rather than on an imagined interpolated value.
    x: Number((CHART_PAD_X + timePosition(point.timestamp, index) * plotWidth).toFixed(1)),
    y: Number(yPosition(point.value).toFixed(1)),
  }));
  const line = coordinates.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' ');
  const last = coordinates[coordinates.length - 1] ?? null;
  const area = last ? `${line} L ${last.x.toFixed(1)} ${CHART_HEIGHT - CHART_PAD_Y} L ${CHART_PAD_X} ${CHART_HEIGHT - CHART_PAD_Y} Z` : '';
  return { line, area, samples: coordinates, last, first, lastPoint, low, high, domainLow, domainHigh, referenceY: validReference ? yPosition(validReference.value) : null };
}
