import {
  BUSINESS_SNAPSHOT_CHANNEL_LABELS,
  BUSINESS_SNAPSHOT_CHANNELS,
  formatBusinessMinorAmount,
  type BusinessSnapshot,
  type BusinessSnapshotRow,
} from "./business-snapshot";

export type BusinessChannelMetric = "transactions" | "gross" | "refunds";

/** Compare only matching, aggregate channel rows supplied in the report. */
export function compareBusinessChannels(snapshot: BusinessSnapshot, metric: BusinessChannelMetric) {
  const measure = (row: BusinessSnapshotRow) => metric === "transactions" ? row.transactions : metric === "gross" ? row.grossMinor : row.refundMinor;
  const format = (value: number) => metric === "transactions"
    ? new Intl.NumberFormat("en-US").format(value)
    : formatBusinessMinorAmount(value, snapshot.currency);

  return BUSINESS_SNAPSHOT_CHANNELS.flatMap((channel) => {
    const previousRow = snapshot.rows.find((row) => row.channel === channel && row.period === "previous");
    const currentRow = snapshot.rows.find((row) => row.channel === channel && row.period === "current");
    if (!previousRow || !currentRow) return [];
    const previous = measure(previousRow);
    const current = measure(currentRow);
    const maximum = Math.max(previous, current);
    const previousWidth = `${maximum > 0 ? previous / maximum * 100 : 0}%` as `${number}%`;
    const currentWidth = `${maximum > 0 ? current / maximum * 100 : 0}%` as `${number}%`;
    const difference = current - previous;
    const absoluteChange = format(Math.abs(difference));
    const change = difference === 0 ? format(0) : `${difference > 0 ? "+" : "−"}${absoluteChange}`;
    const changeDescription = difference === 0 ? "No change" : `${difference > 0 ? "Increase" : "Decrease"} of ${absoluteChange}`;
    let percentage: string;
    if (previous === 0) {
      percentage = "Previous period is zero; percentage unavailable.";
    } else {
      const amount = Math.abs(difference / previous * 100);
      percentage = difference !== 0 && amount < 0.05
        ? `${difference > 0 ? "Increase" : "Decrease"} of less than 0.1%.`
        : `${difference > 0 ? "+" : difference < 0 ? "−" : ""}${new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(amount)}% vs previous.`;
    }
    return [{ channel, label: BUSINESS_SNAPSHOT_CHANNEL_LABELS[channel], previous: format(previous), current: format(current), previousWidth, currentWidth, change, changeDescription, percentage }];
  });
}
