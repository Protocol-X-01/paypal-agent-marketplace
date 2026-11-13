"use client";

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import type { ColDef } from "ag-grid-community";
import { colorSchemeDark, colorSchemeLight, themeQuartz } from "ag-grid-community";
import { AllEnterpriseModule } from "ag-grid-enterprise";
import { AgGridProvider, AgGridReact } from "ag-grid-react";
import { AgCharts } from "ag-charts-react";
import { BarSeriesModule, CategoryAxisModule, LegendModule, NumberAxisModule, type AgChartOptions } from "ag-charts-community";
import { compareBusinessChannels, type BusinessChannelMetric } from "@/lib/business-channel-comparison";
import { formatBusinessPercentage } from "@/lib/business-percentage";
import {
  BUSINESS_SNAPSHOT_CHANNEL_LABELS,
  BUSINESS_SNAPSHOT_CHANNELS,
  BUSINESS_SNAPSHOT_MAX_BYTES,
  createBusinessSnapshotReport,
  formatBusinessMinorAmount,
  parseBusinessSnapshot,
  type BusinessSnapshotReport,
  type BusinessSnapshotRow,
} from "@/lib/business-snapshot";
import styles from "./business-snapshot-panel.module.css";
import { useAppearance } from "./theme-preference";
import { marketChartThemeFor } from "@/lib/market-chart-theme";

const modules = [AllEnterpriseModule];
const comparisonChartModules = [BarSeriesModule, CategoryAxisModule, LegendModule, NumberAxisModule];
type ComparisonMetric = BusinessChannelMetric;
type ChannelComparisonDatum = { channel: string; previous: number; current: number };
const comparisonMetrics: Array<{ id: ComparisonMetric; label: string }> = [
  { id: "transactions", label: "Transactions" },
  { id: "gross", label: "Gross" },
  { id: "refunds", label: "Refunds" },
];

function formatComparisonValue(value: number, metric: ComparisonMetric, currency: string): string {
  return metric === "transactions"
    ? new Intl.NumberFormat("en-US").format(value)
    : formatBusinessMinorAmount(value, currency);
}

function formatMoneyAxisTick(value: number, currency: string): string {
  if (!Number.isFinite(value) || value < 0) return "";
  const nearest = Math.round(value);
  // A chart can place ticks between minor units. Do not round them into a
  // different monetary amount; tolerate only floating-point arithmetic noise.
  if (!Number.isSafeInteger(nearest) || Math.abs(value - nearest) > Number.EPSILON * Math.max(1, Math.abs(value)) * 4) return "";
  const formatted = formatBusinessMinorAmount(nearest, currency);
  return formatted === "Unavailable" ? "" : formatted;
}

export default function BusinessSnapshotPanel({ perspective, onSnapshotChange }: { perspective: "teams" | "leadership"; onSnapshotChange: (active: boolean, report?: BusinessSnapshotReport | null) => void }) {
  const { appearance } = useAppearance();
  const [report, setReport] = useState<BusinessSnapshotReport | null>(null);
  const snapshot = report?.snapshot ?? null;
  const [attestationAccepted, setAttestationAccepted] = useState(false);
  const [error, setError] = useState("");
  const [reading, setReading] = useState(false);
  const [sourceAfterDeviceClock, setSourceAfterDeviceClock] = useState(false);
  const [comparisonMetric, setComparisonMetric] = useState<ComparisonMetric>("transactions");
  const readRevision = useRef(0);
  const gridTheme = useMemo(() => {
    const light = appearance === "light";
    return themeQuartz.withPart(light ? colorSchemeLight : colorSchemeDark).withParams({
      accentColor: light ? "#155eef" : "#0070e0",
      backgroundColor: light ? "#ffffff" : "#151a20",
      foregroundColor: light ? "#10213e" : "#f7fafc",
      chromeBackgroundColor: light ? "#f2f6fb" : "#20262e",
      borderColor: light ? "#e3e9f1" : "rgba(255, 255, 255, .14)",
      spacing: 8,
    });
  }, [appearance]);

  useEffect(() => () => { readRevision.current += 1; }, []);

  const columnDefs = useMemo<ColDef<BusinessSnapshotRow>[]>(() => {
    const currency = snapshot?.currency ?? "USD";
    return [
      { field: "period", headerName: "Period", minWidth: 115, valueFormatter: ({ value }) => value === "current" ? "Current" : "Previous" },
      { field: "channel", headerName: "Sales channel", minWidth: 145, valueFormatter: ({ value }) => value ? BUSINESS_SNAPSHOT_CHANNEL_LABELS[value as BusinessSnapshotRow["channel"]] : "" },
      { field: "transactions", headerName: "Transactions", minWidth: 140, valueFormatter: ({ value }) => typeof value === "number" ? new Intl.NumberFormat("en-US").format(value) : "" },
      { field: "grossMinor", headerName: `Gross (${currency})`, minWidth: 150, valueFormatter: ({ value }) => typeof value === "number" ? formatBusinessMinorAmount(value, currency) : "" },
      { field: "refundMinor", headerName: `Refunds (${currency})`, minWidth: 150, valueFormatter: ({ value }) => typeof value === "number" ? formatBusinessMinorAmount(value, currency) : "" },
    ];
  }, [snapshot?.currency]);
  const defaultColDef = useMemo<ColDef<BusinessSnapshotRow>>(() => ({ flex: 1, sortable: false, filter: false, resizable: false }), []);
  const rows = useMemo(() => snapshot ? [...snapshot.rows].sort((a, b) => a.period.localeCompare(b.period) || a.channel.localeCompare(b.channel)) : [], [snapshot]);
  const channelComparison = useMemo(() => snapshot ? compareBusinessChannels(snapshot, comparisonMetric) : [], [snapshot, comparisonMetric]);
  const channelChartData = useMemo<ChannelComparisonDatum[]>(() => {
    if (!snapshot) return [];
    const measure = (row: BusinessSnapshotRow) => comparisonMetric === "transactions" ? row.transactions : comparisonMetric === "gross" ? row.grossMinor : row.refundMinor;
    return BUSINESS_SNAPSHOT_CHANNELS.flatMap((channel) => {
      const previous = snapshot.rows.find((row) => row.channel === channel && row.period === "previous");
      const current = snapshot.rows.find((row) => row.channel === channel && row.period === "current");
      return previous && current ? [{ channel: BUSINESS_SNAPSHOT_CHANNEL_LABELS[channel], previous: measure(previous), current: measure(current) }] : [];
    });
  }, [snapshot, comparisonMetric]);
  const cards = snapshot ? {
    transactions: { label: "Transactions", value: new Intl.NumberFormat("en-US").format(snapshot.periods.current.transactions), detail: "Current period · not unique customers" },
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
  const chartCurrency = snapshot?.currency ?? "USD";
  const channelChartOptions = useMemo<AgChartOptions<ChannelComparisonDatum>>(() => ({
    theme: marketChartThemeFor(appearance),
    data: channelChartData,
    background: { visible: false },
    animation: { enabled: false },
    padding: { top: 8, right: 16, bottom: 8, left: 8 },
    legend: { enabled: true, position: "bottom" },
    axes: {
      x: {
        type: "number", position: "bottom", min: 0, nice: true,
        label: { formatter: ({ value }) => comparisonMetric === "transactions"
          ? new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(Number(value))
          : formatMoneyAxisTick(Number(value), chartCurrency) },
        gridLine: { style: [{ stroke: appearance === "light" ? "rgba(16, 44, 77, 0.12)" : "rgba(255, 255, 255, 0.12)", strokeWidth: 1 }] },
        line: { enabled: false }, tick: { enabled: false },
      },
      y: { type: "category", position: "left", line: { enabled: false }, tick: { enabled: false } },
    },
    series: [
      { type: "bar", direction: "horizontal", xKey: "channel", yKey: "previous", yName: "Previous period", fill: "#577796", strokeWidth: 0, tooltip: { renderer: ({ datum }) => ({ heading: datum.channel, data: [{ label: "Previous period", value: formatComparisonValue(datum.previous, comparisonMetric, chartCurrency) }] }) } },
      { type: "bar", direction: "horizontal", xKey: "channel", yKey: "current", yName: "Current period", fill: "#0070e0", strokeWidth: 0, tooltip: { renderer: ({ datum }) => ({ heading: datum.channel, data: [{ label: "Current period", value: formatComparisonValue(datum.current, comparisonMetric, chartCurrency) }] }) } },
    ],
  }), [appearance, channelChartData, comparisonMetric, chartCurrency]);

  async function readFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    const attested = attestationAccepted;
    setAttestationAccepted(false);
    if (!attested) {
      setError("Confirm that you are authorized to use the report and that it covers both complete periods before selecting it.");
      return;
    }
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
      const importedReport = createBusinessSnapshotReport(result.snapshot, new Date().toISOString());
      setReport(importedReport);
      setSourceAfterDeviceClock(Date.parse(result.snapshot.sourceUpdatedAt) > Date.now());
      onSnapshotChange(true, importedReport);
    } catch {
      if (revision === readRevision.current) setError("The report could not be read. Please choose it again.");
    } finally {
      if (revision === readRevision.current) setReading(false);
    }
  }

  function clearSnapshot() {
    readRevision.current += 1;
    setReading(false);
    setReport(null);
    setSourceAfterDeviceClock(false);
    setComparisonMetric("transactions");
    setError("");
    setAttestationAccepted(false);
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
      <label className={styles.attestation}>
        <input type="checkbox" checked={attestationAccepted} disabled={reading} onChange={(event) => setAttestationAccepted(event.currentTarget.checked)} />
        <span><strong>Before choosing a report</strong><small>I confirm I am authorized to use the CSV I’m about to select, and have checked that it includes the complete periods I need to compare. The app cannot verify the source, account, population or actual coverage.</small></span>
      </label>
      <div className={styles.actions}>
        <label className={`${styles.fileButton} ${!attestationAccepted || reading ? styles.fileButtonDisabled : ""}`}>
          <span>{reading ? "Reading report…" : snapshot ? "Choose another CSV" : attestationAccepted ? "Choose aggregate CSV" : "Confirm before choosing"}</span>
          <input type="file" accept=".csv,text/csv" onChange={(event) => void readFile(event)} disabled={reading || !attestationAccepted} aria-describedby="business-import-help" />
        </label>
        <a className={styles.templateLink} href="/templates/business-aggregate-template.csv" download>Download blank template</a>
        {snapshot && <button className={styles.clearButton} type="button" onClick={clearSnapshot}>Clear report</button>}
      </div>
      <p id="business-import-help" className={styles.help}>CSV only · Up to 16 KB · Two matching 7- or 30-day periods · One currency</p>
      {error && <p className={styles.error} role="alert">{error}{snapshot ? " The previous report remains displayed." : ""}</p>}
      <details className={styles.instructions}>
        <summary>How to prepare the report</summary>
        <p>Use the template columns exactly. Include a <code>previous</code> and <code>current</code> row for each included channel: <code>online</code>, <code>in_person</code>, or <code>other</code>. Dates are UTC calendar dates in YYYY-MM-DD; <code>end_exclusive</code> is the first day outside the period. Both periods must be consecutive and complete.</p>
        <p>Use an uppercase ISO 4217 currency code with a defined minor unit from the app’s September 2026 list, whole transaction counts, and whole minor units for gross and refunds (for example, 1250 means $12.50 in USD). Use the same source timestamp on every row in UTC, such as <code>2026-11-06T01:30:00Z</code>; it must be at or after the end of the current period. Each row supports up to 1 billion transactions and 1 trillion minor units.</p>
        <p>Example format only; these figures are fictional:</p>
        <pre>{`window_days,period,start_date,end_exclusive,channel,currency,transactions,gross_minor,refund_minor,source_updated_at\n7,previous,2026-10-23,2026-10-30,online,USD,100,100000,2000,2026-11-06T00:00:00Z\n7,current,2026-10-30,2026-11-06,online,USD,120,120000,3000,2026-11-06T00:00:00Z`}</pre>
      </details>
      {snapshot && <div className={styles.report}>
        <div className={styles.reportHeading}>
          <div><p className={styles.eyebrow}>SELF-PROVIDED · UNVERIFIED · NOT LIVE</p><h4>{perspective === "teams" ? "Activity report" : "Report summary"}</h4></div>
          <span>{snapshot.windowDays}-day periods · {snapshot.currency}</span>
        </div>
        <p className={styles.provenance}>UTC dates · Current: {snapshot.periods.current.startDate} to before {snapshot.periods.current.endExclusive}. Previous: {snapshot.periods.previous.startDate} to before {snapshot.periods.previous.endExclusive}. CSV-stated update (not authenticated): {snapshot.sourceUpdatedAt}.</p>
        {sourceAfterDeviceClock && <p className={styles.clockNotice} role="status">The source timestamp was later than this device’s clock when imported. Check the report and device time.</p>}
        {report && <dl className={styles.trustDetails} aria-label="Report provenance and verification limits">
          <div><dt>Source identity</dt><dd>Not authenticated</dd></div>
          <div><dt>Use permission</dt><dd>User-attested · not independently verified</dd></div>
          <div><dt>Population</dt><dd>Uploader-defined · not established</dd></div>
          <div><dt>Period coverage</dt><dd>User-attested · source coverage unverified</dd></div>
          <div><dt>Freshness</dt><dd>Unknown · file timestamp is unauthenticated</dd></div>
          <div><dt>Received by browser</dt><dd>{report.provenance.receivedAt.value} · device clock</dd></div>
        </dl>}
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
                  <strong className={styles.comparisonAmount}>{comparisonMetric === "transactions" ? new Intl.NumberFormat("en-US").format(value) : formatBusinessMinorAmount(value, snapshot.currency)}</strong>
                </div>
                <div className={styles.comparisonTrack} aria-hidden="true"><span className={period === "current" ? styles.comparisonCurrent : styles.comparisonPrevious} style={{ width: `${comparisonMaximum === 0 ? 0 : value / comparisonMaximum * 100}%` }} /></div>
              </div>;
            })}
          </div>
          <p className={styles.comparisonNote}>{comparisonMaximum === 0 ? "Both periods are zero." : "Bars start at zero and use the larger period as their scale."}</p>
          {channelComparison.length > 0 && <section className={styles.channelComparison} aria-labelledby="business-channel-comparison-title">
            <h6 id="business-channel-comparison-title">Change by sales channel</h6>
            <p>Previous and current period · {comparisonMetric === "transactions" ? "transactions" : `${comparisonMetric === "gross" ? "gross" : "refunds"} · ${snapshot.currency}`}</p>
            <div className={styles.channelChart} role="img" aria-label={`AG Charts comparison by sales channel. ${channelChartData.map((row) => `${row.channel}: previous ${formatComparisonValue(row.previous, comparisonMetric, chartCurrency)}, current ${formatComparisonValue(row.current, comparisonMetric, chartCurrency)}`).join(". ")}`}>
              <AgCharts className="ag-market-chart" modules={comparisonChartModules} options={channelChartOptions} />
            </div>
            <ul aria-live="polite" aria-atomic="true">
              {channelComparison.map((row) => <li key={row.channel}>
                <div className={styles.channelSummary}>
                  <div><strong>{row.label}</strong><span>Previous {row.previous} · Current {row.current}</span></div>
                  <div><strong>Change {row.change}</strong><span>{row.percentage}</span></div>
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
