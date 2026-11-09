import type { DisplayCurrency } from './currency';
import { chartPercentageChange, describeMarketChart, metricValueLabel, type ChartPoint, type Metric } from './market';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** Use the same explicit timezone and year for sighted and screen-reader users. */
export function formatChartTime(timestamp: number): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return 'Time unavailable';
  const hour = String(date.getUTCHours()).padStart(2, '0');
  const minute = String(date.getUTCMinutes()).padStart(2, '0');
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}, ${hour}:${minute} UTC`;
}

/** Describe exactly the points passed to the visible (possibly zoomed) chart. */
export function describeVisibleChart(
  metric: Metric,
  low: number,
  high: number,
  currency: DisplayCurrency,
  isPaypalUsd: boolean,
  first: ChartPoint,
  last: ChartPoint,
): string {
  const summary = describeMarketChart(metric, low, high, currency, isPaypalUsd, chartPercentageChange([first, last]));
  const startValue = metricValueLabel(metric, first.value, currency, isPaypalUsd);
  const endValue = metricValueLabel(metric, last.value, currency, isPaypalUsd);
  return `${summary} Visible from ${formatChartTime(first.timestamp)} at ${startValue} to ${formatChartTime(last.timestamp)} at ${endValue}.`;
}
