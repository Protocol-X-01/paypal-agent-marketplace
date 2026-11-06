"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { formatBusinessPercentage } from "@/lib/business-percentage";
import {
  PAYPAL_ACTIVITY_MAX_BYTES,
  summarizePayPalActivity,
  type PayPalActivityOptions,
  type PayPalActivityPeriod,
  type PayPalActivitySummary,
} from "@/lib/paypal-activity-import";
import styles from "./paypal-activity-panel.module.css";

type DateOrder = "" | PayPalActivityOptions["dateOrder"];
type WindowChoice = "" | "7" | "30";

function excluded(period: PayPalActivityPeriod) {
  return period.otherEvent + period.notCompleted + period.notCredit;
}

function PeriodCard({ title, period }: { title: string; period: PayPalActivityPeriod }) {
  return <article className={styles.period}>
    <span>{title}</span>
    <strong>{new Intl.NumberFormat("en-GB").format(period.included)}</strong>
    <small>Included checkout credit rows</small>
    <p>{period.startDate} to before {period.endExclusive} UTC</p>
    <p>{new Intl.NumberFormat("en-GB").format(excluded(period))} other rows excluded</p>
  </article>;
}

export default function PayPalActivityPanel({ onReportChange }: { onReportChange: (active: boolean) => void }) {
  const [dateOrder, setDateOrder] = useState<DateOrder>("");
  const [windowDays, setWindowDays] = useState<WindowChoice>("");
  const [endExclusive, setEndExclusive] = useState("");
  const [privacyConfirmed, setPrivacyConfirmed] = useState(false);
  const [coverageConfirmed, setCoverageConfirmed] = useState(false);
  const [summary, setSummary] = useState<PayPalActivitySummary | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");
  const [todayUtc, setTodayUtc] = useState("");
  const revision = useRef(0);
  useEffect(() => {
    const timer = window.setTimeout(() => setTodayUtc(new Date().toISOString().slice(0, 10)), 0);
    return () => { window.clearTimeout(timer); revision.current += 1; };
  }, []);

  const ready = Boolean(dateOrder && windowDays && endExclusive && todayUtc && endExclusive <= todayUtc && privacyConfirmed && coverageConfirmed);
  function clearReport() {
    revision.current += 1;
    setReading(false);
    setSummary(null);
    setError("");
    onReportChange(false);
  }

  async function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file || !dateOrder || !windowDays || !ready) return;
    const current = ++revision.current;
    setError("");
    if (file.size > PAYPAL_ACTIVITY_MAX_BYTES) {
      setError("The file is too large. Choose one CSV of at most 4 MiB.");
      return;
    }
    setReading(true);
    try {
      const bytes = await file.arrayBuffer();
      if (current !== revision.current) return;
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const result = summarizePayPalActivity(text, {
        dateOrder,
        windowDays: Number(windowDays) as 7 | 30,
        endExclusive,
        coverageConfirmed,
        nowMs: Date.now(),
      });
      if (!result.ok) { setError(result.error); return; }
      setSummary(result.summary);
      onReportChange(true);
    } catch {
      if (current === revision.current) setError("The file could not be read as a UTF-8 CSV. Please choose it again.");
    } finally {
      if (current === revision.current) setReading(false);
    }
  }

  return <section className={styles.panel} aria-labelledby="paypal-activity-title">
    <details id="paypal-activity-details" className={styles.details}>
      <summary><span><strong id="paypal-activity-title">Review a PayPal activity export</strong><small>Optional · separate local preview</small></span></summary>
      <div className={styles.content}>
        <p>Compare a narrow set of completed checkout credit rows from one PayPal account export you are authorized to use. This self-provided preview is not a connected account or a complete sales report.</p>
        <p className={styles.privacy}><strong>Your export may contain customer names, email addresses and other personal information.</strong> The app reads the file in this browser, without uploading or saving it. Your browser or operating system may retain its own copies. Use only business-wide activity you are authorized to review; avoid very small customer groups.</p>
        <div className={styles.requirements}>
          <strong>Before you choose a file</strong>
          <p>Use one UTF-8 PayPal Activity Download CSV with <code>Transaction Event Code</code> and <code>Balance Impact</code> included. Dates must use two-digit day and month fields, and times must use 24-hour <code>HH:MM:SS</code>. This preview supports English status/impact values and rows marked <code>UTC</code> or <code>GMT</code> only. It cannot read split or ZIP exports.</p>
          <p>It counts only <code>T0006</code> and <code>T0007</code> rows marked <code>Completed</code> and <code>Credit</code>. Other rows are excluded. Amounts, refunds, unique customers and retention are not calculated.</p>
        </div>
        <div className={styles.fields}>
          <label>Date format in the export
            <select value={dateOrder} disabled={reading} onChange={(event) => { clearReport(); setDateOrder(event.target.value as DateOrder); }}>
              <option value="">Choose a format</option><option value="dmy">Day / month / year (UK)</option><option value="mdy">Month / day / year (US)</option>
            </select>
          </label>
          <label>Length of each period
            <select value={windowDays} disabled={reading} onChange={(event) => { clearReport(); setWindowDays(event.target.value as WindowChoice); }}>
              <option value="">Choose a period</option><option value="7">7 days</option><option value="30">30 days</option>
            </select>
          </label>
          <label>First day after the current period, in UTC
            <input type="date" max={todayUtc || undefined} value={endExclusive} disabled={reading} onChange={(event) => { clearReport(); setEndExclusive(event.target.value); }} />
          </label>
        </div>
        <p className={styles.hint}>The current period ends just before this day; the previous period is the same length immediately before it. Both must be complete.</p>
        {endExclusive && todayUtc && endExclusive > todayUtc && <p className={styles.error} role="alert">Choose a date no later than today in UTC so the period is complete.</p>}
        <label className={styles.check}><input type="checkbox" checked={privacyConfirmed} disabled={reading} onChange={(event) => { clearReport(); setPrivacyConfirmed(event.target.checked); }} /> <span>I understand the file may contain personal information, and I am authorized to use it here.</span></label>
        <label className={styles.check}><input type="checkbox" checked={coverageConfirmed} disabled={reading} onChange={(event) => { clearReport(); setCoverageConfirmed(event.target.checked); }} /> <span>I confirm this single file covers both complete UTC periods and is not one part of a split export.</span></label>
        <div className={styles.actions}>
          <label className={`${styles.fileButton} ${!ready || reading ? styles.disabled : ""}`}>
            <span>{reading ? "Reading export…" : summary ? "Choose another export" : "Choose PayPal CSV"}</span>
            <input type="file" accept=".csv,text/csv" onChange={(event) => void chooseFile(event)} disabled={!ready || reading} aria-describedby="paypal-activity-help" />
          </label>
          {summary && <button type="button" className={styles.clear} onClick={clearReport}>Clear PayPal preview</button>}
        </div>
        <p id="paypal-activity-help" className={styles.hint}>One CSV · Up to 4 MiB · Up to 50,000 rows · No raw rows shown</p>
        {reading && <p role="status" className={styles.hint}>Reading the selected file locally…</p>}
        {error && <p role="alert" className={styles.error}>{error}{summary ? " The previous preview remains displayed." : ""}</p>}
        {summary && <div className={styles.report}>
          <p className={styles.eyebrow}>SELF-PROVIDED · UNVERIFIED · NOT LIVE</p>
          <h4>Selected PayPal checkout activity</h4>
          <p>Counts reflect only the chosen event types, status and balance impact. They are report rows, not unique customers or complete sales. Coverage is based on your confirmation; the app cannot verify it.</p>
          <div className={styles.periods}><PeriodCard title="Previous period" period={summary.previous} /><PeriodCard title="Current period" period={summary.current} /></div>
          <p className={styles.change}>Included row change: <strong>{summary.changePct === null ? "Unavailable — previous included count is zero" : formatBusinessPercentage(summary.changePct, true)}</strong></p>
          <p className={styles.coverage}>{new Intl.NumberFormat("en-GB").format(summary.rowsInFile)} rows read; {new Intl.NumberFormat("en-GB").format(summary.outsidePeriods)} outside the selected periods. Exclusions include other event types, statuses and non-credit rows. No individual rows, names, email addresses, IDs or amounts are shown.</p>
          <p className={styles.coverage}>The preview clears when you leave Business or choose Clear PayPal preview.</p>
        </div>}
      </div>
    </details>
  </section>;
}
