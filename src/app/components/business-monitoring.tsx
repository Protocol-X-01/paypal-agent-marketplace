"use client";

import { useEffect, useMemo, useState } from "react";
import type { ColDef } from "ag-grid-community";
import { themeQuartz } from "ag-grid-community";
import { AllEnterpriseModule } from "ag-grid-enterprise";
import { AgGridProvider, AgGridReact } from "ag-grid-react";
import styles from "./business-monitoring.module.css";

type Perspective = "teams" | "leadership";

type PlannedAggregateRow = {
  period: string;
  segment: string;
  transactions: number;
  grossVolume: number;
  refundShare: number;
  freshness: string;
};

type PlannedMetric = {
  label: string;
  description: string;
};

const enterpriseModules = [AllEnterpriseModule];
const emptyActivityRows: PlannedAggregateRow[] = [];
const gridTheme = themeQuartz.withParams({
  accentColor: "#1769d2",
  spacing: 8,
});

const allColumnDefs: ColDef<PlannedAggregateRow>[] = [
  { field: "period", headerName: "Period", minWidth: 100 },
  { field: "segment", headerName: "Broad segment", minWidth: 150 },
  { field: "transactions", headerName: "Transactions", minWidth: 125 },
  { field: "grossVolume", headerName: "Gross volume", minWidth: 135 },
  { field: "refundShare", headerName: "Refund share", minWidth: 125 },
  { field: "freshness", headerName: "Data freshness", minWidth: 130 },
];

const mobileColumnFields = new Set<keyof PlannedAggregateRow>([
  "period",
  "segment",
  "transactions",
]);
const mobileColumnWidths: Partial<Record<keyof PlannedAggregateRow, number>> = {
  period: 70,
  segment: 94,
  transactions: 82,
};

const plannedMetrics: Record<Perspective, PlannedMetric[]> = {
  teams: [
    { label: "Transaction activity", description: "Planned aggregate volume by period" },
    { label: "Refund share", description: "Planned aggregate refund rate" },
    { label: "Data freshness", description: "Planned source update time" },
  ],
  leadership: [
    { label: "Customer activity", description: "Planned aggregate transaction trend" },
    { label: "Repeat activity", description: "Requires an approved retention approach" },
    { label: "Refund share", description: "Planned aggregate refund rate" },
  ],
};

function NoActivityOverlay() {
  return (
    <div className={styles.gridEmpty} role="status">
      <strong>No customer activity is being collected.</strong>
      <span>A consented merchant connection and retention review are required.</span>
    </div>
  );
}

export default function BusinessMonitoring() {
  const [perspective, setPerspective] = useState<Perspective>("teams");
  const [compact, setCompact] = useState(false);

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

  return (
    <section className={styles.panel} aria-labelledby="business-monitoring-title">
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>BUSINESS MONITORING</p>
          <h2 id="business-monitoring-title">Customer activity, clearly presented.</h2>
          <p className={styles.introText}>
            An aggregate view for business teams and leaders, designed to keep individual customer details out of the default workspace.
          </p>
        </div>
        <span className={styles.connectionBadge}>
          <span className={styles.statusDot} aria-hidden="true" />
          Not connected
        </span>
      </header>

      <div className={styles.connectionNotice} role="status">
        <span className={styles.noticeIcon} aria-hidden="true">i</span>
        <div className={styles.noticeCopy}>
          <strong>No merchant account is connected.</strong>
          <p>No company customer activity is being collected. This offline preview contains no sample or live company data and makes no PayPal calls.</p>
        </div>
      </div>

      <div className={styles.viewHeader}>
        <div className={styles.perspectiveControl} role="group" aria-label="Choose a presentation view">
          <span className={styles.controlLabel}>View for</span>
          <button
            type="button"
            className={perspective === "teams" ? styles.selectedPerspective : ""}
            aria-pressed={perspective === "teams"}
            onClick={() => setPerspective("teams")}
          >
            Business teams
          </button>
          <button
            type="button"
            className={perspective === "leadership" ? styles.selectedPerspective : ""}
            aria-pressed={perspective === "leadership"}
            onClick={() => setPerspective("leadership")}
          >
            Leadership
          </button>
        </div>
        <p className={styles.previewNote}>Presentation preview only; access permissions are not configured.</p>
      </div>

      <div className={styles.metricGrid} aria-label={`${perspective === "teams" ? "Business team" : "Leadership"} planned aggregate metrics`}>
        {plannedMetrics[perspective].map((metric) => (
          <article className={styles.metricCard} key={metric.label}>
            <span className={styles.metricType}>Planned aggregate</span>
            <p>{metric.label}</p>
            <strong aria-label={`${metric.label}: unavailable`}>—</strong>
            <small>{metric.description}</small>
          </article>
        ))}
      </div>

      <section className={styles.activitySection} aria-labelledby="planned-activity-title">
        <div className={styles.activityHeading}>
          <div>
            <p className={styles.eyebrow}>AGGREGATE ACTIVITY</p>
            <h3 id="planned-activity-title">Planned activity fields</h3>
            <p>Column labels describe the intended view. The grid has no rows or company metrics.</p>
          </div>
          <span className={styles.aggregateBadge}>No personal identifiers</span>
        </div>

        <div className={styles.gridFrame}>
          <AgGridProvider modules={enterpriseModules} licenseKey={licenseKey}>
            <div className={styles.grid}>
              <AgGridReact<PlannedAggregateRow>
                rowData={emptyActivityRows}
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
          <div className={styles.moreFields} aria-label="Additional planned aggregate fields">
            <span>Also planned</span>
            <span>Gross volume</span>
            <span>Refund share</span>
            <span>Data freshness</span>
          </div>
        )}
      </section>

      <footer className={styles.privacyNote}>
        <strong>Data stays off until the rules are ready.</strong>
        <span>Any future connection needs merchant consent, account ownership checks, and an approved retention policy. Repeat-activity reporting is unavailable until its retention approach is approved.</span>
      </footer>
    </section>
  );
}
