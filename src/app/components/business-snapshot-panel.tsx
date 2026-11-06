"use client";

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import type { ColDef } from "ag-grid-community";
import { themeQuartz } from "ag-grid-community";
import { AllEnterpriseModule } from "ag-grid-enterprise";
import { AgGridProvider, AgGridReact } from "ag-grid-react";
import { compareBusinessChannels, type BusinessChannelMetric } from "@/lib/business-channel-comparison";
import { formatBusinessPercentage } from "@/lib/business-percentage";
import {
  BUSINESS_SNAPSHOT_CHANNEL_LABELS,
  BUSINESS_SNAPSHOT_MAX_BYTES,
  formatBusinessMinorAmount,
  parseBusinessSnapshot,
  type BusinessSnapshot,
  type BusinessSnapshotRow,
} from "@/lib/business-snapshot";
import styles from "./business-snapshot-panel.module.css";

const modules = [AllEnterpriseModule];
const gridTheme = themeQuartz.withParams({ accentColor: "#1769d2", spacing: 8 });
type ComparisonMetric = BusinessChannelMetric;
const comparisonMetrics: Array<{ id: ComparisonMetric; label: string }> = [
  { id: "transactions", label: "Transactions" },
  { id: "gross", label: "Gross" },
  { id: "refunds", label: "Refunds" },
];

export default function BusinessSnapshotPanel({ perspective, onSnapshotChange }: { perspective: "teams" | "leadership"; onSnapshotChange: (active: boolean, snapshot?: BusinessSnapshot | null) => void }) {
  const [snapshot, setSnapshot] = useState<BusinessSnapshot | null>(null);
  const [error, setError] = useState("");
  const [reading, setReading] = useState(false);
  const [sourceAfterDeviceClock, setSourceAfterDeviceClock] = useState(false);
  const [comparisonMetric, setComparisonMetric] = useState<ComparisonMetric>("transactions");
  const readRevision = useRef(0);

  useEffect(() => () => { readRevision.current += 1; }, []);

  const columnDefs = useMemo<ColDef<BusinessSnapshotRow>[]>(() => {
    const currency = snapshot?.currency ?? "USD";
    return [
      { field: "period", headerName: "Period", minWidth: 115, valueFormatter: ({ value }) => value === "current" ? "Current" : "Previous" },
      { field: "channel", headerName: "Sales channel", minWidth: 145, valueFormatter: ({ value }) => value ? BUSINESS_SNAPSHOT_CHANNEL_LABELS[value as BusinessSnapshotRow["channel"]] : "" },
      { field: "transactions", headerName: "Transactions", minWidth: 140, valueFormatter: ({ value }) => typeof value === "number" ? new Intl.NumberFormat("en-GB").format(value) : "" },
      { field: "grossMinor", headerName: `Gross (${currency})`, minWidth: 150, valueFormatter: ({ value }) => typeof value === "number" ? formatBusinessMinorAmount(value, currency) : "" },
      { field: "refundMinor", headerName: `Refunds (${currency})`, minWidth: 150, valueFormatter: ({ value }) => typeof value === "number" ? formatBusinessMinorAmount(value, currency) : "" },
    ];
  }, [snapshot?.currency]);
  const defaultColDef = useMemo<ColDef<BusinessSnapshotRow>>(() => ({ flex: 1, sortable: false, filter: false, resizable: false }), []);
  const rows = useMemo(() => snapshot ? [...snapshot.rows].sort((a, b) => a.period.localeCompare(b.period) || a.channel.localeCompare(b.channel)) : [], [snapshot]);
  const channelComparison = useMemo(() => snapshot ? compareBusinessChannels(snapshot, comparisonMetric) : [], [snapshot, comparisonMetric]);
  const cards = snapshot ? {
    transactions: { label: "Transactions", value: new Intl.NumberFormat("en-GB").format(snapshot.periods.current.transactions), detail: "Current period · not unique customers" },
    change: { label: "Activity change", value: formatBusinessPercentage(snapshot.summary.transactionChangePct, true), detail: snapshot.summary.transactionChangePct === null ? "Previous count is zero" : "Compared with previous period" },
    gross: { label: "Gross volume", value: formatBusinessMinorAmount(snapshot.periods.current.grossMinor, snapshot.currency), detail: `Current period · ${snapshot.currency}` },
    refunds: { label: "Refund ratio", value: formatBusinessPercentage(snapshot.summary.refundRatioPct), detail: snapshot.summary.refundRatioPct === null ? "Current gross volume is zero" : "Refund amount divided by gross volume" },
  } : null;
  const cardOrder = perspective === "teams" ? ["transactions", "gross", "refunds", "change"] as const : ["change", "refunds", "gross", "transactions"] as const;
  const comparisonValues = snapshot ? {
    previous: comparisonMetric === "transactions" ? snapshot.periods.previous.transactions : comparisonMetric === "gross" ? snapshot.periods.previous.grossMinor : snapshot.periods.previous.refundMinor,
    current: comparisonMetric === "transactions" ? snapshot.periods.current.transactions : comparisonMetric === "gross" ? snapshot.periods.current.grossMinor : snapshot.periods.current.refundMinor,
  } : null;
  const comparisonMaximum = comparisonValues ? Math.max(comparisonValues.previous, comparisonValues.current) : 0;

  async function readFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    const revision = ++readRevision.current;
    setError("");
    if (file.size > BUSINESS_SNAPSHOT_MAX_BYTES) {
      setError("The file is too large. Use an aggregate snapshot of at most 16 KB.");
      return;
    }
    setReading(true);
    try {
      const text = await file.text();
      if (revision !== readRevision.current) return;
      const result = parseBusinessSnapshot(text);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSnapshot(result.snapshot);
      setSourceAfterDeviceClock(Date.parse(result.snapshot.sourceUpdatedAt) > Date.now());
      onSnapshotChange(true, result.snapshot);
    } catch {
      if (revision === readRevision.current) setError("The report could not be read. Please choose it again.");
    } finally {
      if (revision === readRevision.current) setReading(false);
    }
  }

  function clearSnapshot() {
    readRevision.current += 1;
    setReading(false);
    setSnapshot(null);
    setSourceAfterDeviceClock(false);
    setComparisonMetric("transactions");
    setError("");
    onSnapshotChange(false, null);
  }

  return (
    <section className={styles.panel} aria-labelledby="business-import-title">
      <div className={styles.heading}>
        <div>
          <p className={styles.eyebrow}>BUSINESS REPORTS</p>
          <h3 id="business-import-title">Review an activity report.</h3>
          <p>Compare two periods from an aggregate report you are authorized to use. Use broad channels without identifying or very small groups.</p>
        </div>
        <span className={styles.badge}>Local to this screen</span>
      </div>
      <p className={styles.privacy}>The file is read in this browser, never uploaded or saved by the app. It clears when you leave this workspace or choose Clear report.</p>
      <div className={styles.actions}>
        <label className={styles.fileButton}>
          <span>{reading ? "Reading report…" : snapshot ? "Choose another CSV" : "Choose aggregate CSV"}</span>
          <input type="file" accept=".csv,text/csv" onChange={(event) => void readFile(event)} disabled={reading} aria-describedby="business-import-help" />
        </label>
        <a className={styles.templateLink} href="/templates/business-aggregate-template.csv" download>Download blank template</a>
        {snapshot && <button className={styles.clearButton} type="button" onClick={clearSnapshot}>Clear report</button>}
      </div>
      <p id="business-import-help" className={styles.help}>CSV only · Up to 16 KB · Two matching 7- or 30-day periods · One currency</p>
      {error && <p className={styles.error} role="alert">{error}{snapshot ? " The previous report remains displayed." : ""}</p>}
      <details className={styles.instructions}>
        <summary>How to prepare the report</summary>
        <p>Use the template columns exactly. Include a <code>previous</code> and <code>current</code> row for each included channel: <code>online</code>, <code>in_person</code>, or <code>other</code>. Dates are UTC calendar dates in YYYY-MM-DD; <code>end_exclusive</code> is the first day outside the period. Both periods must be consecutive and complete.</p>
        <p>Use an uppercase ISO 4217 currency code with a defined minor unit from the app’s September 2026 list, whole transaction counts, and whole minor units for gross and refunds (for example, 1250 means £12.50 in GBP). Use the same source timestamp on every row in UTC, such as <code>2026-11-06T01:30:00Z</code>; it must be at or after the end of the current period. Each row supports up to 1 billion transactions and 1 trillion minor units.</p>
        <p>Example format only; these figures are fictional:</p>
        <pre>{`window_days,period,start_date,end_exclusive,channel,currency,transactions,gross_minor,refund_minor,source_updated_at\n7,previous,2026-10-23,2026-10-30,online,GBP,100,100000,2000,2026-11-06T00:00:00Z\n7,current,2026-10-30,2026-11-06,online,GBP,120,120000,3000,2026-11-06T00:00:00Z`}</pre>
      </details>
      {snapshot && <div className={styles.report}>
        <div className={styles.reportHeading}>
          <div><p className={styles.eyebrow}>SELF-PROVIDED · UNVERIFIED · NOT LIVE</p><h4>{perspective === "teams" ? "Activity report" : "Report summary"}</h4></div>
          <span>{snapshot.windowDays}-day periods · {snapshot.currency}</span>
        </div>
        <p className={styles.provenance}>UTC dates · Current: {snapshot.periods.current.startDate} to before {snapshot.periods.current.endExclusive}. Previous: {snapshot.periods.previous.startDate} to before {snapshot.periods.previous.endExclusive}. Source-stated update: {snapshot.sourceUpdatedAt}.</p>
        {sourceAfterDeviceClock && <p className={styles.clockNotice} role="status">The source timestamp was later than this device’s clock when imported. Check the report and device time.</p>}
        <div className={styles.metrics}>{cards && cardOrder.map((key) => <article key={key}><span>{cards[key].label}</span><strong>{cards[key].value}</strong><small>{cards[key].detail}</small></article>)}</div>
        {comparisonValues && <figure className={styles.comparison} aria-labelledby="business-comparison-title">
          <figcaption className={styles.comparisonHeading}>
            <div>
              <p className={styles.eyebrow}>TWO-PERIOD COMPARISON</p>
              <h5 id="business-comparison-title">Compare your totals.</h5>
              <p>Totals across the channels in your report.</p>
            </div>
            <div className={styles.comparisonControls} role="group" aria-label="Choose comparison measure">
              {comparisonMetrics.map((metric) => <button key={metric.id} type="button" aria-pressed={comparisonMetric === metric.id} onClick={() => setComparisonMetric(metric.id)}>{metric.label}</button>)}
            </div>
          </figcaption>
          <p className={styles.comparisonMeasure} aria-live="polite">{comparisonMetric === "transactions" ? "Transactions" : `${comparisonMetric === "gross" ? "Gross" : "Refunds"} · ${snapshot.currency}`}</p>
          <div className={styles.comparisonRows}>
            {(["previous", "current"] as const).map((period) => {
              const value = comparisonValues[period];
              const range = snapshot.periods[period];
              return <div className={styles.comparisonRow} key={period}>
                <div className={styles.comparisonRowHeading}>
                  <div><strong>{period === "previous" ? "Previous period" : "Current period"}</strong><span>{range.startDate} to before {range.endExclusive} · UTC</span></div>
                  <strong className={styles.comparisonAmount}>{comparisonMetric === "transactions" ? new Intl.NumberFormat("en-GB").format(value) : formatBusinessMinorAmount(value, snapshot.currency)}</strong>
                </div>
                <div className={styles.comparisonTrack} aria-hidden="true"><span className={period === "current" ? styles.comparisonCurrent : styles.comparisonPrevious} style={{ width: `${comparisonMaximum === 0 ? 0 : value / comparisonMaximum * 100}%` }} /></div>
              </div>;
            })}
          </div>
          <p className={styles.comparisonNote}>{comparisonMaximum === 0 ? "Both periods are zero." : "Bars start at zero and use the larger period as their scale."}</p>
          {channelComparison.length > 0 && <section className={styles.channelComparison} aria-labelledby="business-channel-comparison-title">
            <h6 id="business-channel-comparison-title">Change by sales channel</h6>
            <p>Compare each channel’s two periods. Bars use that channel’s larger value as their scale.</p>
            <ul aria-live="polite" aria-atomic="true">
              {channelComparison.map((row) => <li key={row.channel}>
                <div className={styles.channelSummary}>
                  <div><strong>{row.label}</strong><span>Previous {row.previous} · Current {row.current}</span></div>
                  <div><strong>Change {row.change}</strong><span>{row.percentage}</span></div>
                </div>
                <div className={styles.channelBars} aria-hidden="true">
                  <div className={styles.channelBar}><span>Previous</span><div className={styles.channelTrack}><i className={styles.comparisonPrevious} style={{ width: row.previousWidth }} /></div></div>
                  <div className={styles.channelBar}><span>Current</span><div className={styles.channelTrack}><i className={styles.comparisonCurrent} style={{ width: row.currentWidth }} /></div></div>
                </div>
              </li>)}
            </ul>
          </section>}
        </figure>}
        <p className={styles.gridNote}>Amounts and dates are supplied by you and have not been verified. Refunds may exceed gross volume; transactions do not measure unique customers or retention.</p>
        <div className={styles.grid} aria-label="Imported aggregate activity by sales channel">
          <AgGridProvider modules={modules} licenseKey={process.env.NEXT_PUBLIC_AG_GRID_LICENSE ?? ""}>
            <AgGridReact<BusinessSnapshotRow> rowData={rows} columnDefs={columnDefs} defaultColDef={defaultColDef} theme={gridTheme} suppressContextMenu />
          </AgGridProvider>
        </div>
        <p className={styles.mobileHint}>Swipe the table horizontally to see all columns.</p>
      </div>}
    </section>
  );
}
