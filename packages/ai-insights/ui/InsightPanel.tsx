"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { InsightKind, InsightResponse } from "../contracts";
import { requestInsight, type InsightSelection } from "./client";
import styles from "./insight-panel.module.css";

type InsightPanelProps = { kind: InsightKind; selection: InsightSelection; enabled?: boolean };
type Result = { status: "pending" | "success" | "error"; response?: InsightResponse; error?: string };
const utc = (value: string | number) => new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(value)) + " UTC";
const interval = (minutes: number) => minutes >= 1440 ? `${minutes / 1440}-day` : minutes >= 60 ? `${minutes / 60}-hour` : `${minutes}-minute`;
const count = (value: number) => new Intl.NumberFormat("en-US").format(value);

export default function InsightPanel({ kind, selection, enabled = true }: InsightPanelProps) {
  // A view owns its request and result, including when a previous selection returns.
  return <InsightPanelView key={JSON.stringify([kind, selection, enabled])} kind={kind} selection={selection} enabled={enabled} />;
}

function InsightPanelView({ kind, selection, enabled = true }: InsightPanelProps) {
  const headingId = useId();
  const active = useRef<{ controller: AbortController; token: symbol; timeout: ReturnType<typeof setTimeout> } | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const pending = result?.status === "pending";
  const response = result?.status === "success" ? result.response : null;
  const report = kind === "fictional-report";

  useEffect(() => () => {
    const request = active.current;
    active.current = null;
    if (request) { clearTimeout(request.timeout); request.controller.abort(); }
  }, []);

  async function generate() {
    if (!enabled || active.current) return;
    const controller = new AbortController();
    const token = Symbol("insight");
    const timeout = setTimeout(() => controller.abort(), 35_000);
    active.current = { controller, token, timeout };
    setResult({ status: "pending" });
    try {
      const next = await requestInsight(kind, selection, controller.signal);
      if (!controller.signal.aborted && active.current?.token === token) setResult({ status: "success", response: next });
    } catch (error) {
      if (active.current?.token === token) setResult({ status: "error", error: controller.signal.aborted ? "The summary took too long. Please try again shortly." : error instanceof Error ? error.message : "The summary is unavailable. Please try again." });
    } finally {
      clearTimeout(timeout);
      if (active.current?.token === token) active.current = null;
    }
  }

  return <section className={styles.panel} aria-labelledby={headingId}>
    <div className={styles.heading}>
      <div><p className={styles.eyebrow}><span aria-hidden="true">✧</span> AI ASSISTANCE</p><h2 id={headingId}>{report ? "A clearer read of this report." : "Put the market in perspective."}</h2>
        <p className={styles.intro}>{report ? "Generate an explanation of the selected fictional report. Only the example period and filters are used." : "Generate a short explanation from a separate public OHLC snapshot for this asset and range. Its candle samples may differ from the price line. Your holdings and personal data are not used."}</p></div>
      <span className={styles.badge}>{report ? "Fictional report" : "Public market data"}</span>
    </div>
    <div className={styles.action}><button type="button" disabled={!enabled || pending} aria-busy={pending} onClick={() => void generate()}>{pending ? "Preparing your summary…" : response ? "Generate a new summary" : report ? "Summarize fictional report" : "Generate market overview"}<span aria-hidden="true">{pending ? "◌" : "↗"}</span></button><span>{enabled ? "AI explanation · OpenAI" : report ? "Select the fictional preview to use AI assistance." : "AI assistance is unavailable for this view."}</span></div>
    <div aria-live="polite" aria-atomic="false">
      {pending && <p className={styles.progress} role="status">{report ? "Reading the selected example and its reporting coverage…" : "Reading the reference history and its observed price changes…"}</p>}
      {result?.status === "error" && <p className={styles.error} role="alert">{result.error}</p>}
      {response && <div className={styles.result}>
        <div className={styles.resultHeading}><h3>{response.insight.headline}</h3><span>AI-generated</span></div>
        <p className={styles.summary}>{response.insight.summary}</p>
        <ul className={styles.observations}>{response.insight.observations.map((observation, index) => <li key={index}>{observation}</li>)}</ul>
        <p className={styles.caution}>{response.insight.caution}</p>
        <dl className={styles.source}>
          <div><dt>Source</dt><dd>{response.source.provider}</dd></div>
          {response.kind === "market" ? <><div><dt>Selected market</dt><dd>{response.source.coinId} · {response.source.days} days · {response.source.currency}</dd></div><div><dt>Candle history retrieved</dt><dd>{utc(response.source.retrievedAt)}</dd></div><div><dt>Observations · OHLC snapshot</dt><dd>{count(response.source.sampleCount)} {interval(response.source.candleIntervalMinutes)} candles · candle-close prices</dd></div><div><dt>Observed close times</dt><dd>{utc(response.source.firstTimestamp)} – {utc(response.source.lastTimestamp)}</dd></div></> : <><div><dt>Example timestamp</dt><dd>{utc(response.source.fixtureTimestamp)}</dd></div><div><dt>Selected report</dt><dd>{response.source.days} days · {response.source.account} · {response.source.market}</dd></div><div><dt>Current fictional period · end exclusive</dt><dd>{utc(response.source.currentStart)} – {utc(response.source.currentEnd)}</dd></div><div><dt>Prior fictional period · end exclusive</dt><dd>{utc(response.source.priorStart)} – {utc(response.source.priorEnd)}</dd></div><div><dt>Active accounts · fictional</dt><dd>{count(response.source.currentActive)}</dd></div><div><dt>Completed events · fictional</dt><dd>{count(response.source.currentCompleted)}</dd></div></>}
          <div><dt>Summary generated</dt><dd>{utc(response.generatedAt)}</dd></div>
        </dl>
        <p className={styles.disclaimer}>{response.disclaimer}</p>
      </div>}
    </div>
  </section>;
}
