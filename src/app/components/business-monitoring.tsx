"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ColDef } from "ag-grid-community";
import { themeQuartz } from "ag-grid-community";
import { AllEnterpriseModule } from "ag-grid-enterprise";
import { AgGridProvider, AgGridReact } from "ag-grid-react";
import { assessExternalBusinessPlan, BUSINESS_PLAN_STORAGE_KEY, createDefaultPlan, indicatorsByPerspective, readBusinessPlan, saveBusinessPlan, type BusinessPlanDraft, type BusinessPlanRead, type BusinessPlanStorageState, type DraftView, type IndicatorId, type MonitoringPlan, type Perspective, type ReportingWindow } from "@/lib/business-plan-storage";
import { LOCAL_DATA_RESET_SIGNAL } from "@/lib/portfolio-input";
import { formatBusinessMinorAmount, type BusinessSnapshot } from "@/lib/business-snapshot";
import { formatBusinessPercentage } from "@/lib/business-percentage";
import BusinessSnapshotPanel from "./business-snapshot-panel";
import PayPalActivityPanel from "./paypal-activity-panel";
import styles from "./business-monitoring.module.css";
import { usePrivateDataScope } from "./customer-session";

type PlannedAggregateRow = {
  period: string;
  segment: string;
  transactions: number;
  grossVolume: number;
  refundShare: number;
  freshness: string;
};

const enterpriseModules = [AllEnterpriseModule];
const emptyActivityRows: PlannedAggregateRow[] = [];
const SAMPLE_DATA_LABEL = "Sample data — not live PayPal activity";
const sampleSegments = [
  { segment: "Online services", compactSegment: "Online", previous: { transactions: 210, grossVolume: 14_280, refundShare: 2.1 }, current: { transactions: 226, grossVolume: 15_980, refundShare: 1.9 } },
  { segment: "In-person sales", compactSegment: "In person", previous: { transactions: 176, grossVolume: 9_550, refundShare: 3.4 }, current: { transactions: 182, grossVolume: 10_125, refundShare: 3.1 } },
  { segment: "Other sales", compactSegment: "Other", previous: { transactions: 84, grossVolume: 3_750, refundShare: 4.2 }, current: { transactions: 91, grossVolume: 4_235, refundShare: 3.9 } },
];
const gridTheme = themeQuartz.withParams({
  accentColor: "#1769d2",
  spacing: 8,
});

const allColumnDefs: ColDef<PlannedAggregateRow>[] = [
  { field: "period", headerName: "Period", minWidth: 100 },
  { field: "segment", headerName: "Broad segment", minWidth: 150 },
  {
    field: "transactions",
    headerName: "Transactions",
    minWidth: 125,
    valueFormatter: (params) => typeof params.value === "number" ? new Intl.NumberFormat("en-US").format(params.value) : "",
  },
  {
    field: "grossVolume",
    headerName: "Gross volume",
    minWidth: 135,
    valueFormatter: (params) => typeof params.value === "number" ? formatSampleCurrency(params.value) : "",
  },
  {
    field: "refundShare",
    headerName: "Refund share",
    minWidth: 125,
    valueFormatter: (params) => typeof params.value === "number" ? `${params.value.toFixed(1)}%` : "",
  },
  { field: "freshness", headerName: "Data freshness", minWidth: 130 },
];

const mobileColumnFields = new Set<keyof PlannedAggregateRow>([
  "period",
  "segment",
  "transactions",
]);
const mobileColumnWidths: Partial<Record<keyof PlannedAggregateRow, number>> = {
  period: 76,
  segment: 90,
  transactions: 76,
};

function createSampleRows(windowDays: ReportingWindow, compact: boolean): PlannedAggregateRow[] {
  const scale = windowDays / 7;
  return sampleSegments.flatMap(({ segment, compactSegment, previous, current }) => [
    {
      period: compact ? `Prior ${windowDays}d` : `Previous ${windowDays} days`,
      segment: compact ? compactSegment : segment,
      transactions: Math.round(previous.transactions * scale),
      grossVolume: previous.grossVolume * scale,
      refundShare: previous.refundShare,
      freshness: "Sample only",
    },
    {
      period: compact ? `Now ${windowDays}d` : `Selected ${windowDays} days`,
      segment: compact ? compactSegment : segment,
      transactions: Math.round(current.transactions * scale),
      grossVolume: current.grossVolume * scale,
      refundShare: current.refundShare,
      freshness: "Sample only",
    },
  ]);
}

function summarizeSampleRows(rows: PlannedAggregateRow[]) {
  const previousRows = rows.filter((row) => row.period.startsWith("Previous") || row.period.startsWith("Prior "));
  const currentRows = rows.filter((row) => row.period.startsWith("Selected") || row.period.startsWith("Now "));
  const sum = (items: PlannedAggregateRow[], field: "transactions" | "grossVolume") =>
    items.reduce((total, row) => total + row[field], 0);
  const weightedRefundShare = (items: PlannedAggregateRow[]) => {
    const volume = sum(items, "grossVolume");
    if (volume === 0) return 0;
    return items.reduce((total, row) => total + row.grossVolume * row.refundShare, 0) / volume;
  };
  const previousTransactions = sum(previousRows, "transactions");
  const currentTransactions = sum(currentRows, "transactions");

  return {
    previousTransactions,
    currentTransactions,
    currentRefundShare: weightedRefundShare(currentRows),
    activityChange: previousTransactions === 0 ? 0 : (currentTransactions - previousTransactions) / previousTransactions * 100,
  };
}

function formatSampleMetric(id: IndicatorId, summary: ReturnType<typeof summarizeSampleRows>) {
  switch (id) {
    case "transactionVolume":
      return { value: new Intl.NumberFormat("en-US").format(summary.currentTransactions), detail: "transactions in the selected sample period" };
    case "activityTrend":
      return { value: `${summary.activityChange >= 0 ? "+" : ""}${summary.activityChange.toFixed(1)}%`, detail: "transaction activity versus the previous sample period" };
    case "refundShare":
      return { value: `${summary.currentRefundShare.toFixed(1)}%`, detail: "weighted by sample gross volume" };
    case "dataFreshness":
      return { value: "Illustrative", detail: "no PayPal business account is connected" };
    case "customerAccounts":
      return { value: "Unavailable", detail: "requires an approved customer activity definition and company feed" };
    case "repeatActivity":
      return { value: "Unavailable", detail: "requires an approved identity and cohort definition" };
  }
}

function formatSampleCurrency(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

function ThresholdControl({
  id,
  label,
  description,
  value,
  min,
  max,
  step,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  description: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <label className={`${styles.thresholdControl} ${disabled ? styles.disabledControl : ""}`} htmlFor={id}>
      <span className={styles.thresholdLabel}>{label}</span>
      <output htmlFor={id}>{value}%</output>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <small>{description}</small>
    </label>
  );
}

function NoActivityOverlay() {
  return (
    <div className={styles.gridEmpty} role="status">
      <strong>No business activity is connected.</strong>
      <span>Choose a report or preview a fictional example.</span>
    </div>
  );
}

export default function BusinessMonitoring({ draftRef, onDraftChange }: { draftRef: { current: BusinessPlanDraft | null }; onDraftChange: (pending: boolean) => void }) {
  const privateData = usePrivateDataScope();
  const localStorage = privateData.storage;
  const privateEvents = privateData.events;
  const [plan, setPlan] = useState<MonitoringPlan>(createDefaultPlan);
  const [showSampleData, setShowSampleData] = useState(false);
  const [hasImportedSnapshot, setHasImportedSnapshot] = useState(false);
  const [importedSnapshot, setImportedSnapshot] = useState<BusinessSnapshot | null>(null);
  const [hasPayPalReport, setHasPayPalReport] = useState(false);
  const [compact, setCompact] = useState(false);
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const [storageState, setStorageState] = useState<BusinessPlanStorageState>("loading");
  const [storageNotice, setStorageNotice] = useState("");
  const [hasUnsavedPlan, setHasUnsavedPlan] = useState(false);
  const planRef = useRef(plan);
  const storageStateRef = useRef<BusinessPlanStorageState>("loading");
  const planBaseline = useRef<string | null>(null);
  const pendingPlan = useRef(false);

  const perspective = plan.perspective;
  const hasReport = hasImportedSnapshot || hasPayPalReport;
  const currentView = plan.views[perspective];
  const currentIndicators = indicatorsByPerspective[perspective];
  const activityRows = useMemo(
    () => showSampleData ? createSampleRows(currentView.windowDays, compact) : emptyActivityRows,
    [compact, currentView.windowDays, showSampleData],
  );
  const sampleSummary = useMemo(() => summarizeSampleRows(activityRows), [activityRows]);
  const reportTransactions = importedSnapshot ? new Intl.NumberFormat("en-GB").format(importedSnapshot.periods.current.transactions) : showSampleData ? new Intl.NumberFormat("en-GB").format(sampleSummary.currentTransactions) : "—";
  const reportGross = importedSnapshot ? formatBusinessMinorAmount(importedSnapshot.periods.current.grossMinor, importedSnapshot.currency) : showSampleData ? formatSampleCurrency(activityRows.filter((row) => row.period.startsWith("Selected") || row.period.startsWith("Now ")).reduce((total, row) => total + row.grossVolume, 0)) : "—";
  const reportRefunds = importedSnapshot ? formatBusinessPercentage(importedSnapshot.summary.refundRatioPct) : showSampleData ? `${sampleSummary.currentRefundShare.toFixed(1)}%` : "—";
  const activityIndicator = perspective === "teams" ? "transactionVolume" : "activityTrend";
  const sampleThresholds = [
    {
      id: "activity",
      label: "Activity drop",
      enabled: currentView.indicators.includes(activityIndicator),
      crossed: sampleSummary.activityChange <= -currentView.activityDropPct,
      detail: `Sample activity changed ${sampleSummary.activityChange >= 0 ? "+" : ""}${sampleSummary.activityChange.toFixed(1)}%; threshold is a ${currentView.activityDropPct}% drop.`,
    },
    {
      id: "refundShare",
      label: "Refund share",
      enabled: currentView.indicators.includes("refundShare"),
      crossed: sampleSummary.currentRefundShare >= currentView.refundSharePct,
      detail: `Sample refund share is ${sampleSummary.currentRefundShare.toFixed(1)}%; threshold is ${currentView.refundSharePct}%.`,
    },
  ];

  const changeStorageState = useCallback((next: BusinessPlanStorageState) => {
    storageStateRef.current = next;
    setStorageState(next);
  }, []);

  const readCurrentPlan = useCallback((): BusinessPlanRead => {
    try { return readBusinessPlan(localStorage); }
    catch { return { kind: "unavailable" }; }
  }, [localStorage]);

  const acceptSavedPlan = useCallback((result: BusinessPlanRead, notice = "") => {
    if (result.kind === "unreadable") {
      changeStorageState("unreadable");
      setStorageNotice("The saved plan could not be read and remains untouched. Export it or reset local data in Settings. Unsaved changes remain only while this dashboard is open; exports contain saved data only.");
    } else if (result.kind === "unavailable") {
      changeStorageState("unavailable");
      setStorageNotice("Browser storage is unavailable. Unsaved changes remain only while this dashboard is open; exports contain saved data only.");
    } else {
      const saved = result.kind === "valid" ? result.plan : createDefaultPlan();
      planRef.current = saved;
      planBaseline.current = result.baseline;
      pendingPlan.current = false;
      draftRef.current = null;
      onDraftChange(false);
      setPlan(saved);
      setHasUnsavedPlan(false);
      changeStorageState("ready");
      setStorageNotice(notice);
    }
    setPreferencesLoaded(true);
  }, [changeStorageState, draftRef, onDraftChange]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const retained = draftRef.current;
      if (!retained) { acceptSavedPlan(readCurrentPlan()); return; }
      planRef.current = retained.plan;
      planBaseline.current = retained.baseline;
      pendingPlan.current = true;
      setPlan(retained.plan);
      setHasUnsavedPlan(true);
      const result = readCurrentPlan();
      if (result.kind === "unreadable" || result.kind === "unavailable") { acceptSavedPlan(result); return; }
      changeStorageState("conflict");
      setPreferencesLoaded(true);
      setStorageNotice(result.baseline === retained.baseline
        ? "Your unsaved draft was restored and remains only while this dashboard is open. Loading the saved plan replaces it; exports contain saved data only."
        : "The saved plan changed while you were away. Your unsaved draft was restored and remains only while this dashboard is open. Loading the saved plan replaces it; exports contain saved data only.");
    }, 0);
    const observeChange = (reset: boolean) => {
      if (storageStateRef.current === "loading") return;
      const result = readCurrentPlan();
      if (reset) {
        draftRef.current = null;
        pendingPlan.current = false;
        const defaults = createDefaultPlan();
        planRef.current = defaults;
        planBaseline.current = null;
        setPlan(defaults);
        setHasUnsavedPlan(false);
        onDraftChange(false);
        acceptSavedPlan(result, "Local data was reset. The current saved plan is shown.");
        return;
      }
      const decision = assessExternalBusinessPlan(result, planBaseline.current, pendingPlan.current, reset, storageStateRef.current);
      if (decision === "unreadable" || decision === "unavailable") {
        acceptSavedPlan(result);
        return;
      }
      if (decision === "conflict") {
        changeStorageState("conflict");
        setStorageNotice("The saved plan changed. Your unsaved draft remains while this dashboard is open; loading the saved plan replaces it. Exports contain saved data only.");
        return;
      }
      if (decision === "load") {
        acceptSavedPlan(result, reset ? "Local data was reset. The current saved plan is shown." : "The saved plan was updated in another tab.");
      }
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== BUSINESS_PLAN_STORAGE_KEY && event.key !== LOCAL_DATA_RESET_SIGNAL && event.key !== null) return;
      if (event.key === LOCAL_DATA_RESET_SIGNAL && event.newValue === null) return;
      try { if (event.storageArea !== window.localStorage) return; }
      catch { acceptSavedPlan({ kind: "unavailable" }); return; }
      observeChange(event.key === LOCAL_DATA_RESET_SIGNAL || event.key === null);
    };
    const onReset = () => observeChange(true);
    privateEvents.addEventListener("storage", onStorage);
    privateEvents.addEventListener("paypal-markets-data-reset", onReset);
    return () => {
      window.clearTimeout(timer);
      privateEvents.removeEventListener("storage", onStorage);
      privateEvents.removeEventListener("paypal-markets-data-reset", onReset);
    };
  }, [acceptSavedPlan, changeStorageState, draftRef, onDraftChange, readCurrentPlan, privateEvents]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 700px)");
    const updateLayout = () => setCompact(media.matches);
    updateLayout();
    media.addEventListener("change", updateLayout);
    return () => media.removeEventListener("change", updateLayout);
  }, []);

  const columnDefs = useMemo(
    () => {
      if (!compact) return allColumnDefs;
      return allColumnDefs
        .filter((column) => column.field && mobileColumnFields.has(column.field as keyof PlannedAggregateRow))
        .map((column) => ({
          ...column,
          headerName: column.field === "transactions" ? "Txns" : column.field === "segment" ? "Segment" : "Period",
          suppressHeaderMenuButton: true,
          minWidth: mobileColumnWidths[column.field as keyof PlannedAggregateRow],
        }));
    },
    [compact],
  );

  const defaultColDef = useMemo<ColDef<PlannedAggregateRow>>(
    () => ({
      flex: 1,
      sortable: false,
      filter: false,
      resizable: false,
    }),
    [],
  );

  const licenseKey = process.env.NEXT_PUBLIC_AG_GRID_LICENSE ?? "";
  const selectedMetrics = currentIndicators.filter((indicator) => currentView.indicators.includes(indicator.id));

  function persistPlan(next: MonitoringPlan, baseline = planBaseline.current) {
    let result;
    try { result = saveBusinessPlan(localStorage, baseline, next); }
    catch { result = { kind: "unavailable" } as const; }
    if (result.kind === "saved") {
      planBaseline.current = result.baseline;
      pendingPlan.current = false;
      draftRef.current = null;
      onDraftChange(false);
      setHasUnsavedPlan(false);
      changeStorageState("ready");
      setStorageNotice("Draft preferences are saved on this device only.");
    } else if (result.kind === "changed") {
      changeStorageState("conflict");
      setStorageNotice("The saved plan changed. Your unsaved draft remains while this dashboard is open; loading the saved plan replaces it. Exports contain saved data only.");
    } else {
      acceptSavedPlan(result);
    }
  }

  function updatePlan(nextPlan: (current: MonitoringPlan) => MonitoringPlan) {
    if (!preferencesLoaded) return;
    const next = nextPlan(planRef.current);
    if (JSON.stringify(next) === JSON.stringify(planRef.current)) return;
    planRef.current = next;
    pendingPlan.current = true;
    draftRef.current = { plan: next, baseline: planBaseline.current };
    onDraftChange(true);
    setHasUnsavedPlan(true);
    setPlan(next);
    if (storageStateRef.current === "ready") persistPlan(next);
  }

  function loadSavedPlan() {
    acceptSavedPlan(readCurrentPlan(), "Loaded the current saved plan from this browser.");
  }

  function replaceSavedPlan() {
    if (storageStateRef.current !== "conflict" || !pendingPlan.current) return;
    const latest = readCurrentPlan();
    if (latest.kind === "unavailable" || latest.kind === "unreadable") { acceptSavedPlan(latest); return; }
    persistPlan(planRef.current, latest.baseline);
  }

  function retryPlanStorage() {
    if (pendingPlan.current) persistPlan(planRef.current);
    else acceptSavedPlan(readCurrentPlan());
  }

  function updateCurrentView(updates: Partial<DraftView>) {
    updatePlan((current) => ({
      ...current,
      views: {
        ...current.views,
        [current.perspective]: { ...current.views[current.perspective], ...updates },
      },
    }));
  }

  function choosePerspective(nextPerspective: Perspective) {
    updatePlan((current) => ({ ...current, perspective: nextPerspective }));
  }

  function toggleIndicator(id: IndicatorId, checked: boolean) {
    const option = currentIndicators.find((item) => item.id === id);
    if (!option || option.gated) return;
    const indicators = checked
      ? [...currentView.indicators, id]
      : currentView.indicators.filter((currentId) => currentId !== id);
    updateCurrentView({ indicators: Array.from(new Set(indicators)) });
  }

  return (
    <section className={styles.panel} aria-labelledby="business-monitoring-title">
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>PAYPAL BUSINESS</p>
          <h2 id="business-monitoring-title">Your business, in view.</h2>
          <p className={styles.introText}>
            Review your activity and compare the reports you choose to bring into this preview.
          </p>
        </div>
        <span className={styles.connectionBadge}>
          <span className={styles.statusDot} aria-hidden="true" />
          Account not connected
        </span>
      </header>

      <div className={styles.connectionNotice} role="status">
        <span className={styles.noticeIcon} aria-hidden="true">i</span>
        <div className={styles.noticeCopy}>
          <strong>No PayPal business account is connected.</strong>
          <p>{hasReport
            ? "Your report is self-provided, unverified, and stays on this screen. It is not a live account balance."
            : showSampleData
              ? "The figures below are fictional examples and are not PayPal account activity."
              : "Explore an example or choose an aggregate report. This preview does not retrieve live account data."}</p>
        </div>
      </div>

      <section className={styles.accountOverview} aria-labelledby="business-overview-title">
        <div className={styles.overviewTop}>
          <div><p id="business-overview-title">PAYPAL BALANCE</p><strong aria-label="Balance unavailable">—</strong><span>Account not connected</span></div>
          <div className={styles.overviewSource}>{importedSnapshot ? "SELF-PROVIDED REPORT" : showSampleData ? "FICTIONAL EXAMPLE" : "ACCOUNT PREVIEW"}</div>
        </div>
        <div className={styles.overviewMetrics}>
          <article><span>Report activity</span><strong>{reportTransactions}</strong><small>{importedSnapshot ? "Transactions · current period" : showSampleData ? "Fictional transactions" : "Choose a report"}</small></article>
          <article><span>Gross activity</span><strong>{reportGross}</strong><small>{importedSnapshot ? `${importedSnapshot.currency} · current period` : showSampleData ? "Fictional USD values" : "Not a balance"}</small></article>
          <article><span>Refund ratio</span><strong>{reportRefunds}</strong><small>{importedSnapshot || showSampleData ? "Refunds ÷ gross activity" : "Choose a report"}</small></article>
        </div>
      </section>

      <nav className={styles.accountLinks} aria-label="Business tools">
        <a href="https://www.paypal.com/uk/business" target="_blank" rel="noopener noreferrer"><span>Get paid</span><small>PayPal Business · UK info</small><b aria-hidden="true">↗</b></a>
        <a href="#business-import-title"><span>Activity reports</span><small>Compare periods</small><b aria-hidden="true">→</b></a>
        <a href="#paypal-activity-title" onClick={() => document.getElementById("paypal-activity-details")?.setAttribute("open", "")}><span>PayPal activity</span><small>Review an export</small><b aria-hidden="true">→</b></a>
        <a href="https://www.paypal.com/uk/business/pos-system" target="_blank" rel="noopener noreferrer"><span>In-person sales</span><small>PayPal Point of Sale · UK info</small><b aria-hidden="true">↗</b></a>
      </nav>

      <div className={styles.viewHeader}>
        <div className={styles.perspectiveControl} role="group" aria-label="Choose a presentation view">
          <span className={styles.controlLabel}>Report view</span>
          <button
            type="button"
            className={perspective === "teams" ? styles.selectedPerspective : ""}
            aria-pressed={perspective === "teams"}
            disabled={!preferencesLoaded}
            onClick={() => choosePerspective("teams")}
          >
            Activity
          </button>
          <button
            type="button"
            className={perspective === "leadership" ? styles.selectedPerspective : ""}
            aria-pressed={perspective === "leadership"}
            disabled={!preferencesLoaded}
            onClick={() => choosePerspective("leadership")}
          >
            Summary
          </button>
        </div>
        <div className={styles.previewActions}>
          <button
            type="button"
            className={showSampleData ? styles.sampleToggleActive : styles.sampleToggle}
            aria-pressed={showSampleData}
            disabled={hasReport}
            onClick={() => setShowSampleData((visible) => !visible)}
          >
            {showSampleData ? "Hide sample data" : "Preview sample data"}
          </button>
          <p className={styles.previewNote}>{hasReport ? "Clear the imported reports to preview sample data." : "The example is fictional and does not access your account."}</p>
        </div>
      </div>

      <BusinessSnapshotPanel perspective={perspective} onSnapshotChange={(active, snapshot) => { setHasImportedSnapshot(active); setImportedSnapshot(snapshot ?? null); if (active) setShowSampleData(false); }} />
      <PayPalActivityPanel onReportChange={(active) => { setHasPayPalReport(active); if (active) setShowSampleData(false); }} />

      {showSampleData && (
        <div className={styles.sampleNotice} role="status" aria-live="polite">
          <strong>{SAMPLE_DATA_LABEL}</strong>
          <span>These fictional figures were not retrieved from PayPal and do not describe a real business.</span>
        </div>
      )}

      {showSampleData && <section className={styles.sampleComparison} aria-labelledby="sample-comparison-title">
        <div><p className={styles.eyebrow}>FICTIONAL EXAMPLE · {currentView.windowDays}-DAY PERIODS</p><h3 id="sample-comparison-title">Activity over two periods</h3><p>Transaction counts from the sample below.</p></div>
        {([['Previous period', sampleSummary.previousTransactions], ['Current period', sampleSummary.currentTransactions]] as const).map(([label, value], index) => <div className={styles.sampleComparisonRow} key={label}>
          <div><span>{label}</span><strong>{new Intl.NumberFormat("en-GB").format(value)}</strong></div>
          <div className={styles.sampleTrack} aria-hidden="true"><span className={index ? styles.sampleCurrent : styles.samplePrevious} style={{ width: `${Math.max(sampleSummary.previousTransactions, sampleSummary.currentTransactions) ? value / Math.max(sampleSummary.previousTransactions, sampleSummary.currentTransactions) * 100 : 0}%` }} /></div>
        </div>)}
      </section>}

      <details className={styles.settingsDetails}>
        <summary>Report preferences and preview settings</summary>

      <section className={styles.planSection} aria-labelledby="monitoring-plan-title">
        <div className={styles.planHeading}>
          <div>
            <p className={styles.eyebrow}>MONITORING PLAN</p>
            <h3 id="monitoring-plan-title">Choose the signals that matter.</h3>
            <p>These are draft preferences only. No live data source is active and no alerts are running.</p>
          </div>
          <span className={styles.draftBadge}>Draft · inactive</span>
        </div>

        <div className={styles.planGrid}>
          <fieldset className={styles.planFieldset}>
            <legend>Planned aggregate indicators</legend>
            <div className={styles.indicatorList}>
              {currentIndicators.map((indicator) => {
                const gated = Boolean(indicator.gated);
                return (
                  <label key={indicator.id} className={`${styles.indicatorOption} ${gated ? styles.gatedOption : ""}`}>
                    <input
                      type="checkbox"
                      checked={currentView.indicators.includes(indicator.id)}
                      disabled={gated || !preferencesLoaded}
                      onChange={(event) => toggleIndicator(indicator.id, event.target.checked)}
                    />
                    <span className={styles.indicatorCopy}>
                      <strong>{indicator.label}</strong>
                      <small>{indicator.id === "customerAccounts" ? "Requires authorized customer data and an approved definition." : indicator.description}</small>
                    </span>
                    {gated && <span className={styles.gateLabel}>Policy gate</span>}
                  </label>
                );
              })}
            </div>
          </fieldset>

          <div className={styles.planControls}>
            <fieldset className={styles.windowFieldset}>
              <legend>Planned reporting window</legend>
              <div className={styles.windowOptions}>
                {([7, 30] as ReportingWindow[]).map((days) => (
                  <button
                    key={days}
                    type="button"
                    className={currentView.windowDays === days ? styles.selectedWindow : ""}
                    aria-pressed={currentView.windowDays === days}
                    disabled={!preferencesLoaded}
                    onClick={() => updateCurrentView({ windowDays: days })}
                  >
                    {days} days
                  </button>
                ))}
              </div>
              <small>Planning only. Imported report periods are fixed by the file.</small>
            </fieldset>

            <fieldset className={styles.thresholdFieldset}>
              <legend>Draft alert thresholds</legend>
              <ThresholdControl
                id={`${perspective}-activity-threshold`}
                label="Activity drop"
                description="Draft condition: activity falls by this amount versus the previous period."
                value={currentView.activityDropPct}
                min={5}
                max={50}
                step={5}
                disabled={!preferencesLoaded || !currentView.indicators.includes(perspective === "teams" ? "transactionVolume" : "activityTrend")}
                onChange={(value) => updateCurrentView({ activityDropPct: value })}
              />
              <ThresholdControl
                id={`${perspective}-refund-threshold`}
                label="Refund share"
                description="Draft condition: aggregate refund share reaches this level."
                value={currentView.refundSharePct}
                min={1}
                max={20}
                step={1}
                disabled={!preferencesLoaded || !currentView.indicators.includes("refundShare")}
                onChange={(value) => updateCurrentView({ refundSharePct: value })}
              />
            </fieldset>
          </div>
        </div>

        <p className={styles.storageNotice} role="status">
          {preferencesLoaded
            ? storageNotice || "Changes to this plan are saved in this browser only."
            : "Loading saved plan preferences…"}
        </p>
        {storageState === "conflict" && hasUnsavedPlan && <div className={styles.windowOptions}>
          <button type="button" onClick={loadSavedPlan}>Load saved plan</button>
          <button type="button" onClick={replaceSavedPlan}>Replace saved plan with this draft</button>
        </div>}
        {(storageState === "unreadable" || storageState === "unavailable") && <div className={styles.windowOptions}>
          <button type="button" onClick={retryPlanStorage}>{hasUnsavedPlan ? "Retry saving" : "Retry loading"}</button>
        </div>}
        <p className={styles.storageNotice}>Changes in another tab are checked before saving. Two tabs saving at the same instant may still overwrite a plan.</p>
      </section>

      {showSampleData && !hasReport && <section className={styles.plannedSummary} aria-label={`${perspective === "teams" ? "Activity" : "Summary"} sample aggregate indicators`}>
        {selectedMetrics.length ? selectedMetrics.map((metric) => (
          <article className={styles.metricCard} key={metric.id}>
            <span className={styles.metricType}>{showSampleData ? SAMPLE_DATA_LABEL : "Planned aggregate"}</span>
            <p>{metric.label}</p>
            <strong aria-label={`${metric.label}: ${showSampleData ? formatSampleMetric(metric.id, sampleSummary).value : "unavailable"}`}>
              {showSampleData ? formatSampleMetric(metric.id, sampleSummary).value : "—"}
            </strong>
            <small>{showSampleData ? formatSampleMetric(metric.id, sampleSummary).detail : metric.description}</small>
          </article>
        )) : (
          <div className={styles.noIndicators}>No indicators selected for this draft view.</div>
        )}
      </section>}

      {showSampleData && (
        <section className={styles.thresholdPreview} aria-labelledby="sample-threshold-title" role="status" aria-live="polite">
          <div className={styles.thresholdPreviewHeading}>
            <div>
              <p className={styles.eyebrow}>SAMPLE ONLY</p>
              <h3 id="sample-threshold-title">Threshold preview</h3>
            </div>
            <span>{SAMPLE_DATA_LABEL}</span>
          </div>
          <p className={styles.thresholdPreviewNote}>This checks the selected draft thresholds against synthetic figures. It does not create alerts or monitor customer activity.</p>
          <div className={styles.thresholdPreviewGrid}>
            {sampleThresholds.map((threshold) => (
              <article className={styles.thresholdPreviewCard} key={threshold.id}>
                <strong>{threshold.label}</strong>
                <span className={threshold.enabled && threshold.crossed ? styles.thresholdCrossed : styles.thresholdClear}>
                  {!threshold.enabled ? "Not included" : threshold.crossed ? "Would cross in sample" : "Below sample threshold"}
                </span>
                <small>{threshold.enabled ? threshold.detail : "Select this indicator to preview its threshold."}</small>
              </article>
            ))}
          </div>
        </section>
      )}
      </details>

      {showSampleData && !hasReport && <section className={styles.activitySection} aria-labelledby="planned-activity-title">
        <div className={styles.activityHeading}>
          <div>
            <p className={styles.eyebrow}>AGGREGATE ACTIVITY</p>
            <h3 id="planned-activity-title">Illustrative activity by channel</h3>
            <p>{SAMPLE_DATA_LABEL}</p>
          </div>
          <span className={showSampleData ? styles.sampleGridBadge : styles.aggregateBadge}>
            {SAMPLE_DATA_LABEL}
          </span>
        </div>

        <div className={styles.gridFrame}>
          <AgGridProvider modules={enterpriseModules} licenseKey={licenseKey}>
            <div className={styles.grid}>
              <AgGridReact<PlannedAggregateRow>
                rowData={activityRows}
                columnDefs={columnDefs}
                defaultColDef={defaultColDef}
                theme={gridTheme}
                noRowsOverlayComponent={NoActivityOverlay}
                suppressCellFocus
              />
            </div>
          </AgGridProvider>
        </div>

        {compact && (
          <div className={styles.moreFields} aria-label={showSampleData ? "Additional sample aggregate fields" : "Additional planned aggregate fields"}>
            <span>{showSampleData ? "Also in sample" : "Also planned"}</span>
            <span>Gross volume</span>
            <span>Refund share</span>
            <span>Data freshness</span>
          </div>
        )}
      </section>}

      <footer className={styles.privacyNote}>
        <strong>Only plan preferences are saved here.</strong>
        <span>The saved draft contains the selected view, aggregate indicators, reporting window, and thresholds. Imported report data stays in memory until you clear it or leave this workspace; it is not saved or sent by the app.</span>
      </footer>
    </section>
  );
}
