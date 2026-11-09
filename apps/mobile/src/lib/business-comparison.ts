import { formatBusinessMinorAmount, type BusinessSnapshot } from './business-snapshot';

export const BUSINESS_COMPARISON_METRICS = [
  { id: 'transactions', label: 'Transactions' },
  { id: 'gross', label: 'Gross' },
  { id: 'refunds', label: 'Refunds' },
] as const;

export type BusinessComparisonMetric = (typeof BUSINESS_COMPARISON_METRICS)[number]['id'];

/** Compare only the two aggregate totals supplied by the report. */
export function buildBusinessComparison(snapshot: BusinessSnapshot, metric: BusinessComparisonMetric) {
  const totals = [snapshot.periods.previous, snapshot.periods.current];
  const values = totals.map((period) => metric === 'transactions' ? period.transactions : metric === 'gross' ? period.grossMinor : period.refundMinor);
  const maximum = Math.max(...values);
  const rows = totals.map((period, index) => {
    const value = values[index];
    const label = index === 0 ? 'Previous period' : 'Current period';
    const formatted = metric === 'transactions'
      ? String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
      : formatBusinessMinorAmount(value, snapshot.currency);
    const width = `${maximum > 0 ? (value / maximum) * 100 : 0}%` as `${number}%`;
    return { label, startDate: period.startDate, endExclusive: period.endExclusive, formatted, width };
  });
  return { rows, bothZero: maximum === 0 };
}
