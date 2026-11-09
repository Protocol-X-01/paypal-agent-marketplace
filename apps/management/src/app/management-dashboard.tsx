"use client";

import { useMemo, useState, type ReactNode } from "react";
import InsightPanel from "../../../../packages/ai-insights/ui/InsightPanel";
import {
  cohortName, fictionalDailyEvents, filterAggregates, formatCount, formatDate,
  formatPercent, formatPeriod, getFictionalPeriod, percentChange, ratio,
  summarize, tableRows,
  type AccountFilter, type AggregateRow, type AggregateSummary, type FictionalPeriod,
  type MarketFilter, type PeriodDays, type SortDirection, type SortKey,
} from "../lib/management-data";

type View = "overview" | "cohorts" | "activity" | "setup";
type Presentation = "Operations" | "Leadership";

const views: { id: View; label: string; icon: string }[] = [
  { id: "overview", label: "Overview", icon: "overview" },
  { id: "cohorts", label: "Cohort comparison", icon: "cohorts" },
  { id: "activity", label: "Aggregate activity", icon: "table" },
  { id: "setup", label: "Staff setup", icon: "setup" },
];

function Icon({ name }: { name: string }) {
  const paths: Record<string, ReactNode> = {
    overview: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
    cohorts: <><path d="M4 7h16M4 12h11M4 17h17" /><circle cx="17" cy="12" r="2" /></>,
    table: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M3 14h18M9 9v11" /></>,
    setup: <><path d="M12 3v4m0 10v4M3 12h4m10 0h4M5.6 5.6l2.8 2.8m7.2 7.2 2.8 2.8M5.6 18.4l2.8-2.8m7.2-7.2 2.8-2.8" /><circle cx="12" cy="12" r="5" /></>,
    arrow: <path d="m8 5 7 7-7 7" />,
    source: <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v7c0 4 16 4 16 0V5M4 12v7c0 4 16 4 16 0v-7" /></>,
    search: <><circle cx="10" cy="10" r="6" /><path d="m15 15 5 5" /></>,
  };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] ?? paths.overview}</svg>;
}

function PanelHeading({ eyebrow, title, detail }: { eyebrow: string; title: string; detail?: string }) {
  return <div className="panel-heading"><div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2></div>{detail && <span className="panel-detail">{detail}</span>}</div>;
}

function NoSource({ compact = false }: { compact?: boolean }) {
  return <div className={`no-source${compact ? " compact" : ""}`}><span className="source-symbol"><Icon name="source" /></span><div><h3>No authorized reporting source</h3><p>Staff access and an approved aggregate source are required.</p></div></div>;
}

function changeLabel(current: number, previous: number): string {
  const change = percentChange(current, previous);
  return change === null ? "No prior-period denominator" : `${change >= 0 ? "+" : ""}${formatPercent(change)} vs previous period`;
}

function MetricStrip({ summary, presentation }: { summary: AggregateSummary | null; presentation: Presentation }) {
  const volume = summary ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 }).format(summary.currentGrossMinor / 100) : "—";
  const metrics = presentation === "Leadership" ? [
    { label: "Active customer accounts", value: summary ? formatCount(summary.currentActive) : "—", note: summary ? changeLabel(summary.currentActive, summary.priorActive) : null },
    { label: "Prior-period retention", value: summary ? formatPercent(summary.retention) : "—", note: summary ? `${formatCount(summary.retained)} of ${formatCount(summary.priorActive)} prior active accounts` : null },
    { label: "Included gross payment volume", value: volume, note: summary ? "Fictional USD · before fees and refunds" : null },
    { label: "Completed payment events", value: summary ? formatCount(summary.currentCompleted) : "—", note: summary ? changeLabel(summary.currentCompleted, summary.priorCompleted) : null },
  ] : [
    { label: "Active customer accounts", value: summary ? formatCount(summary.currentActive) : "—", note: summary ? changeLabel(summary.currentActive, summary.priorActive) : null },
    { label: "Completed payment events", value: summary ? formatCount(summary.currentCompleted) : "—", note: summary ? changeLabel(summary.currentCompleted, summary.priorCompleted) : null },
    { label: "Payment completion", value: summary ? formatPercent(summary.completion) : "—", note: summary ? `${formatCount(summary.currentCompleted)} of ${formatCount(summary.currentAttempted)} included attempts` : null },
    { label: "Prior-period retention", value: summary ? formatPercent(summary.retention) : "—", note: summary ? `${formatCount(summary.retained)} of ${formatCount(summary.priorActive)} prior active accounts` : null },
  ];
  return <div className="metrics" aria-label={summary ? "Fictional aggregate metrics" : "Unavailable aggregate metrics"}>{metrics.map((metric) => <article className="metric" key={metric.label}><p>{metric.label}</p><strong>{metric.value}</strong>{metric.note && <span>{metric.note}</span>}</article>)}</div>;
}

function CohortMovement({ summary, period }: { summary: AggregateSummary | null; period: FictionalPeriod | null }) {
  if (!summary || !period) return <section className="panel cohort-panel"><PanelHeading eyebrow="Account continuity" title="Active population" /><NoSource /></section>;
  const maximum = Math.max(summary.priorActive, summary.currentActive, 1);
  const segments = [
    { label: "Retained", value: summary.retained, color: "retained", detail: "Active in both periods" },
    { label: "Reactivated", value: summary.reactivated, color: "reactivated", detail: "Existing · inactive last period" },
    { label: "Newly active", value: summary.newlyActive, color: "new-active", detail: "Opened and active this period" },
    { label: "No longer active", value: summary.noLongerActive, color: "no-longer", detail: "Active last period only" },
  ];
  return <section className="panel cohort-panel"><PanelHeading eyebrow="Fictional cohort comparison" title="Active population" detail={`${period.days}-day periods · same scale`} />
    <div className="population-chart" role="img" aria-label={`Fictional previous active population ${formatCount(summary.priorActive)}: ${formatCount(summary.retained)} retained and ${formatCount(summary.noLongerActive)} no longer active. Current population ${formatCount(summary.currentActive)}: ${formatCount(summary.retained)} retained, ${formatCount(summary.reactivated)} reactivated and ${formatCount(summary.newlyActive)} newly active.`}>
      <div className="population-row"><div className="population-label"><span>Previous period</span><small>{formatPeriod(period.priorStart, period.priorEnd)}</small></div><div className="population-track"><span className="population-segment retained" style={{ width: `${summary.retained / maximum * 100}%` }} /><span className="population-segment no-longer" style={{ width: `${summary.noLongerActive / maximum * 100}%` }} /></div><strong>{formatCount(summary.priorActive)}</strong></div>
      <div className="population-row"><div className="population-label"><span>Current period</span><small>{formatPeriod(period.currentStart, period.currentEnd)}</small></div><div className="population-track"><span className="population-segment retained" style={{ width: `${summary.retained / maximum * 100}%` }} /><span className="population-segment reactivated" style={{ width: `${summary.reactivated / maximum * 100}%` }} /><span className="population-segment new-active" style={{ width: `${summary.newlyActive / maximum * 100}%` }} /></div><strong>{formatCount(summary.currentActive)}</strong></div>
    </div>
    <div className="cohort-legend">{segments.map((segment) => <div key={segment.label}><i className={segment.color} /><span>{segment.label}</span><strong>{formatCount(segment.value)}</strong><small>{segment.detail}</small></div>)}</div>
    <p className="chart-caption">One cohort per account · Retention = retained ÷ previous active accounts.</p>
  </section>;
}

function ActivityTrend({ summary, period }: { summary: AggregateSummary | null; period: FictionalPeriod | null }) {
  if (!summary || !period) return <section className="panel trend-panel"><PanelHeading eyebrow="Payment activity" title="Completed events by day" /><NoSource compact /></section>;
  const daily = fictionalDailyEvents(summary, period.days);
  const maximum = Math.max(...daily.flatMap((point) => [point.current, point.prior]), 1);
  const chartMax = Math.ceil(maximum / 1_000) * 1_000;
  const left = 62; const right = 704; const top = 24; const bottom = 206;
  const x = (i: number) => left + i / (daily.length - 1) * (right - left);
  const y = (value: number) => bottom - value / chartMax * (bottom - top);
  const path = (key: "current" | "prior") => daily.map((point, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(2)},${y(point[key]).toFixed(2)}`).join(" ");
  return <section className="panel trend-panel"><PanelHeading eyebrow="Fictional payment activity" title="Completed events by day" detail="Day within each equal period" />
    <div className="trend-key"><span><i className="retained" /> Current period</span><span><i className="prior-line" /> Previous period</span></div>
    <svg className="trend-chart" viewBox="0 0 730 250" role="img" aria-label={`Fictional daily completed payment events, ${period.days} days per period. Current total ${formatCount(summary.currentCompleted)}, previous total ${formatCount(summary.priorCompleted)}. Vertical scale starts at zero.`}>
      {[0, 0.5, 1].map((fraction) => <g key={fraction}><line x1={left} x2={right} y1={y(chartMax * fraction)} y2={y(chartMax * fraction)} className="chart-grid" /><text x={left - 10} y={y(chartMax * fraction) + 4} textAnchor="end" className="axis-text">{new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(chartMax * fraction)}</text></g>)}
      <path d={path("prior")} className="previous-trend" /><path d={path("current")} className="current-trend" />
      {[0, Math.floor((daily.length - 1) / 2), daily.length - 1].map((i) => <text key={i} x={x(i)} y="234" textAnchor="middle" className="axis-text">Day {i + 1}</text>)}
    </svg>
    <p className="chart-caption">Fictional events, not unique customers. No forecast or live signal.</p>
  </section>;
}

function CompletionComparison({ summary, period }: { summary: AggregateSummary | null; period: FictionalPeriod | null }) {
  if (!summary || !period) return <section className="panel completion-panel"><PanelHeading eyebrow="Payment activity" title="Payment completion" /><NoSource compact /></section>;

  const periods = [
    { label: "Previous period", start: period.priorStart, end: period.priorEnd, rate: summary.priorCompletion, completed: summary.priorCompleted, attempted: summary.priorAttempted },
    { label: "Current period", start: period.currentStart, end: period.currentEnd, rate: summary.completion, completed: summary.currentCompleted, attempted: summary.currentAttempted },
  ];
  const change = summary.completionChangePoints === null ? null : new Intl.NumberFormat("en-US", {
    signDisplay: "exceptZero", minimumFractionDigits: 1, maximumFractionDigits: 1,
  }).format(summary.completionChangePoints);

  return <section className="panel completion-panel"><PanelHeading eyebrow="Fictional payment activity" title="Payment completion" detail={`${period.days}-day periods · selected population`} />
    <div className="completion-grid">{periods.map((item, index) => <div className="completion-period" key={item.label}>
      <p className="completion-label">{item.label}</p><p className="completion-date">{formatPeriod(item.start, item.end)}</p>
      <strong className="completion-value">{formatPercent(item.rate)}</strong>
      <p className="completion-count">{formatCount(item.completed)} of {formatCount(item.attempted)} attempts completed</p>
      {item.rate !== null && <div className="completion-track" aria-hidden="true"><span className={index === 0 ? "completion-previous" : "completion-current"} style={{ width: `${item.rate * 100}%` }} /></div>}
    </div>)}
      <div className="completion-difference"><p className="completion-label">Change from previous period</p><strong>{change === null ? "Unavailable" : `${change} percentage points`}</strong>{change === null && <p>A comparison needs included attempts in both periods.</p>}<p>{formatCount(summary.currentAttempted - summary.currentCompleted)} current-period attempts not completed</p></div>
    </div>
    <p className="chart-caption">Fictional events, not unique customers. “Not completed” does not identify a cause or indicate a live alert.</p>
  </section>;
}

function Definitions({ leadership = false }: { leadership?: boolean }) {
  return <section className="panel definitions-panel"><h2 className="definitions-heading">{leadership ? "Read the population before the percentage" : "Metric definitions"}</h2>
    <dl className="definitions"><div><dt>Active account</dt><dd>1+ included completed events per period. Unique fictional accounts.</dd></div><div><dt>Retained account</dt><dd>Active in both periods. Retention = retained ÷ previous active accounts; zero denominator unavailable.</dd></div><div><dt>Reporting scope</dt><dd>Personal / Business · fixed market attribution. Other = remaining fictional markets.</dd></div><div><dt>Included payment events</dt><dd>Fictional attempts and outcomes. Not completed = attempts − completions. Gross USD before fees/refunds; not revenue or balance.</dd></div></dl>
  </section>;
}

function AggregateTable({ rows, preview, query, setQuery, sort, direction, onSort, selected, onSelect }: {
  rows: readonly AggregateRow[]; preview: boolean; query: string; setQuery: (query: string) => void;
  sort: SortKey; direction: SortDirection; onSort: (sort: SortKey) => void;
  selected: string | null; onSelect: (id: string | null) => void;
}) {
  const visibleRows = tableRows(rows, query, sort, direction);
  const selectedRow = rows.find((row) => row.id === selected);
  const headings: { key: SortKey; label: string }[] = [
    { key: "cohort", label: "Aggregate cohort" }, { key: "currentActive", label: "Active accounts" },
    { key: "currentCompleted", label: "Completed events" }, { key: "completion", label: "Completion" }, { key: "retention", label: "Retention" },
  ];
  return <section className="panel table-panel"><PanelHeading eyebrow={preview ? "Fictional aggregate rows" : "Aggregate reporting"} title="Aggregate cohorts" detail={preview ? `${visibleRows.length} of ${rows.length} cohorts shown` : "Source unavailable"} />
    <div className="table-toolbar"><label className="search-label"><Icon name="search" /><span className="sr-only">Filter aggregate cohorts</span><input type="search" placeholder="Cohort, account type or market" value={query} onChange={(event) => { setQuery(event.target.value); onSelect(null); }} disabled={!preview} /></label><span>Filters this table only.</span></div>
    {!preview ? <NoSource compact /> : <>
      <div className="table-scroll" role="region" aria-label="Fictional aggregate activity table" tabIndex={0}><table><caption className="sr-only">Fictional cohorts for the selected reporting period, account type and market. Select a cohort to read its denominator.</caption><thead><tr>{headings.map((heading) => <th key={heading.key} scope="col" aria-sort={sort === heading.key ? direction : "none"}><button onClick={() => onSort(heading.key)}>{heading.label}<span aria-hidden="true">{sort === heading.key ? direction === "ascending" ? "↑" : "↓" : "↕"}</span></button></th>)}</tr></thead><tbody>{visibleRows.map((row) => <tr key={row.id} className={selected === row.id ? "selected-row" : undefined}><th scope="row"><button className="cohort-button" aria-pressed={selected === row.id} onClick={() => onSelect(selected === row.id ? null : row.id)}><strong>{row.accountType} <span>{row.age.toLowerCase()}</span></strong><small>{row.market} market · fictional cohort</small></button></th><td>{formatCount(row.currentActive)}</td><td>{formatCount(row.currentCompleted)}</td><td>{formatPercent(ratio(row.currentCompleted, row.currentAttempted))}</td><td>{formatPercent(ratio(row.retained, row.priorActive))}</td></tr>)}</tbody></table></div>
      {visibleRows.length === 0 && <p className="table-empty" role="status">No fictional cohorts match “{query}”. Change the table search or reporting filters.</p>}
      {selectedRow && <div className="cohort-detail" role="status"><div><p className="eyebrow">Selected fictional cohort</p><h3>{cohortName(selectedRow)}</h3><p>{formatCount(selectedRow.retained)} retained ÷ {formatCount(selectedRow.priorActive)} previous active accounts = {formatPercent(ratio(selectedRow.retained, selectedRow.priorActive))}. {selectedRow.age === "New" ? "New accounts have no previous-period denominator." : `${formatCount(selectedRow.currentActive - selectedRow.retained)} existing accounts reactivated during this period.`}</p></div><button className="text-button" onClick={() => onSelect(null)}>Close detail</button></div>}
    </>}
    <p className="chart-caption">No individual customer records. Real reporting requires approved grouping, minimum cohort sizes and access review.</p>
  </section>;
}

function StaffSetup() {
  return <div className="setup-content"><section className="panel setup-intro"><PanelHeading eyebrow="Staff setup" title="Reporting requirements" detail="All connections unconfigured" /><p>Local concept · no staff sign-in, customer feed or live monitoring. Fictional preview only.</p></section>
    <div className="setup-grid"><section className="panel setup-card"><span className="setup-icon"><Icon name="setup" /></span><span className="status-label">Not configured</span><h2>Staff identity & report access</h2><p>Operations and Leadership are presentation choices here, not access roles.</p><ul><li>Authorized staff SSO and session policy</li><li>Staff roles and approved report permissions</li><li>Audit and access review owners</li></ul></section><section className="panel setup-card"><span className="setup-icon"><Icon name="source" /></span><span className="status-label">No source connected</span><h2>Authorized aggregate source</h2><p>Agree the population and definitions with the data owner.</p><ul><li>Source owner, period boundaries and attribution</li><li>Delivery timestamp and freshness expectations</li><li>Missing fields, late events and completeness rules</li></ul></section><section className="panel setup-card"><span className="setup-icon"><Icon name="cohorts" /></span><span className="status-label">Review required</span><h2>Customer data safeguards</h2><p>Separate from customer accounts; approved aggregate use only.</p><ul><li>Minimum cohort sizes and small-group suppression</li><li>Purpose, consent or other authorized basis</li><li>Retention, correction and export policy</li></ul></section></div>
    <section className="setup-note"><strong>Read-only concept</strong><p>No payments, refunds, account changes, subscriptions or customer contact. No keys or customer records requested.</p></section>
  </div>;
}

export default function ManagementDashboard() {
  const [view, setView] = useState<View>("overview");
  const [presentation, setPresentation] = useState<Presentation>("Operations");
  const [preview, setPreview] = useState(false);
  const [days, setDays] = useState<PeriodDays>(7);
  const [accountFilter, setAccountFilter] = useState<AccountFilter>("All");
  const [marketFilter, setMarketFilter] = useState<MarketFilter>("All");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("currentActive");
  const [direction, setDirection] = useState<SortDirection>("descending");
  const [selected, setSelected] = useState<string | null>(null);

  const period = useMemo(() => preview ? getFictionalPeriod(days) : null, [preview, days]);
  const rows = useMemo(() => period ? filterAggregates(period.rows, accountFilter, marketFilter) : [], [period, accountFilter, marketFilter]);
  const summary = preview ? summarize(rows) : null;
  const title = view === "overview" ? "Customer activity" : view === "cohorts" ? "Cohort comparison" : view === "activity" ? "Aggregate activity" : "Staff setup";

  function togglePreview() {
    setPreview((current) => !current);
    setDays(7); setAccountFilter("All"); setMarketFilter("All");
    setQuery(""); setSelected(null); setSort("currentActive"); setDirection("descending");
  }

  function changeScope() { setQuery(""); setSelected(null); }

  function onSort(next: SortKey) {
    if (sort === next) setDirection((current) => current === "ascending" ? "descending" : "ascending");
    else { setSort(next); setDirection(next === "cohort" ? "ascending" : "descending"); }
  }

  return <div className="management-app"><a className="skip-link" href="#report-content">Skip to report</a>
    <aside className="sidebar"><div className="brand"><span className="brand-word">PayPal</span><span className="brand-product">Operations<span>Concept</span></span></div><p className="nav-label">Reporting workspace</p><nav aria-label="Management workspace">{views.map((item) => <button key={item.id} aria-pressed={view === item.id} className={`nav-item${view === item.id ? " active" : ""}`} onClick={() => setView(item.id)}><Icon name={item.icon} /><span>{item.label}</span>{view === item.id && <span className="nav-active-mark" aria-hidden="true" />}</button>)}</nav><div className="sidebar-bottom"><span className="sidebar-status"><i /> Disconnected</span><p>No customer data</p></div></aside>
    <div className="workspace"><header className="topbar"><div className="breadcrumb">Management <Icon name="arrow" /><span>{title}</span></div><button className="identity-status" onClick={() => setView("setup")}><span className="identity-dot" />Staff identity not configured<Icon name="arrow" /></button></header>
      <main id="report-content" tabIndex={-1}><div className="page-heading"><div><p className="eyebrow">PayPal internal reporting concept</p><h1>{title}</h1></div><div className="presentation-group"><span id="presentation-label">Report presentation</span><div className="segmented" role="group" aria-labelledby="presentation-label">{(["Operations", "Leadership"] as const).map((item) => <button key={item} aria-pressed={presentation === item} onClick={() => setPresentation(item)}>{item}</button>)}</div></div></div>
        <div className={`connection-banner${preview ? " preview-banner" : ""}`} role="status"><div><span className="banner-dot" /><div><strong>{preview ? "Fictional preview is on" : "Reporting source disconnected"}</strong><p>{preview ? "Invented figures · never from PayPal · no staff access." : "No approved aggregate source or staff access."}</p></div></div><button className={preview ? "secondary-button" : "primary-button"} onClick={togglePreview}>{preview ? "Hide fictional preview" : "Show fictional preview"}</button></div>
        <section className="provenance" aria-label="Reporting provenance"><div><span>Reporting source</span><strong>{preview ? "Fictional local fixture" : "Not connected"}</strong></div><div><span>{preview ? "Fixture timestamp · UTC" : "Source freshness"}</span><strong>{preview ? "Nov 2, 2026 · 00:35" : "Unavailable"}</strong></div><div><span>Completeness</span><strong>{preview ? "Complete within this fixture" : "Unknown · no source"}</strong></div><div><span>Population</span><strong>{preview ? `${accountFilter === "All" ? "All account types" : accountFilter} · ${marketFilter === "All" ? "all example markets" : marketFilter}` : "Not established"}</strong></div></section>
        {view === "setup" ? <StaffSetup /> : <>
          <div className="scope-toolbar"><div className="scope-selects"><label>Reporting period<select value={days} disabled={!preview} onChange={(event) => { setDays(Number(event.target.value) as PeriodDays); changeScope(); }}><option value={7}>7 days</option><option value={30}>30 days</option></select></label><label>Account type<select value={accountFilter} disabled={!preview} onChange={(event) => { setAccountFilter(event.target.value as AccountFilter); changeScope(); }}><option value="All">All account types</option><option>Personal</option><option>Business</option></select></label><label>Market<select value={marketFilter} disabled={!preview} onChange={(event) => { setMarketFilter(event.target.value as MarketFilter); changeScope(); }}><option value="All">All example markets</option><option>US</option><option>UK</option><option>Other</option></select></label></div><p>{period ? <><span>Current period · UTC</span><strong>{formatPeriod(period.currentStart, period.currentEnd)}</strong></> : <><span>Reporting window</span><strong>Awaiting authorized source</strong></>}</p></div>
          {view === "overview" && <><MetricStrip summary={summary} presentation={presentation} /><CohortMovement summary={summary} period={period} /><div className="overview-grid"><ActivityTrend summary={summary} period={period} /><section className="panel reading-panel"><PanelHeading eyebrow={preview ? "Fictional reporting scope" : "Reporting readiness"} title="Reporting coverage" /><dl><div><dt>Population</dt><dd>{preview ? "12 distinct fictional cohorts before filters · Personal / Business · US / UK / Other" : "Population and report scope not approved."}</dd></div><div><dt>Period comparison</dt><dd>{preview ? `Two consecutive ${days}-day periods ending ${formatDate(period!.currentEnd)} at 00:00 UTC.` : "Timestamps, cutoffs and delayed-event treatment unavailable."}</dd></div></dl>{preview && <p className="chart-caption">Dates include the final day shown · daily counts sum to period totals.</p>}<button className="text-button" onClick={() => setView("setup")}>Review staff setup <Icon name="arrow" /></button></section></div>{presentation === "Leadership" && <Definitions leadership />}</>}
          {view === "overview" && <InsightPanel kind="fictional-report" selection={{ days, account: accountFilter, market: marketFilter }} enabled={preview} />}
          {view === "cohorts" && <><CohortMovement summary={summary} period={period} /><Definitions leadership={presentation === "Leadership"} /></>}
          {view === "activity" && <CompletionComparison summary={summary} period={period} />}
          {(view === "cohorts" || view === "activity") && <AggregateTable rows={rows} preview={preview} query={query} setQuery={setQuery} sort={sort} direction={direction} onSort={onSort} selected={selected} onSelect={setSelected} />}
        </>}
        <footer className="report-footer"><span>PayPal Operations · local concept</span><span>{preview ? "Fictional · no customer records" : "No source"}</span><p>Presentation is not access · preview resets on close.</p></footer>
      </main>
    </div>
  </div>;
}
