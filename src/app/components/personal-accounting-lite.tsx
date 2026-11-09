"use client";

import { useState } from "react";
import { formatLiteMoney, liteClosingAmount, liteCurrencyDigits, liteMonthsToTarget, parseLiteMoney, roundedPortfolioMinor } from "@/lib/personal-accounting-lite";
import type { MarketCurrency } from "@/lib/market-currency";
import styles from "./personal-accounting-lite.module.css";

type Props = { currency: MarketCurrency; portfolioTotal: number | null; portfolioAvailable: boolean };

function MoneyField({ id, label, value, onChange, currency }: { id: string; label: string; value: string; onChange: (value: string) => void; currency: string }) {
  const parsed = parseLiteMoney(value, currency);
  const error = value.length > 32 ? "Enter no more than 32 characters." : parsed.kind === "invalid" ? "Enter a non-negative amount using digits and a decimal point, within this currency’s precision." : parsed.kind === "incomplete" ? "Finish the amount." : "";
  return <label className={styles.field} htmlFor={id}><span>{label} · {currency}</span><input id={id} type="text" inputMode="decimal" autoComplete="off" value={value} onChange={(event) => onChange(event.target.value)} aria-invalid={parsed.kind === "invalid"} aria-describedby={error ? `${id}-error` : undefined} placeholder="0" />{error && <small id={`${id}-error`}>{error}</small>}</label>;
}

function Session({ currency, portfolioTotal, portfolioAvailable }: Props) {
  const [source, setSource] = useState<"manual" | "portfolio">("manual");
  const [startText, setStartText] = useState("");
  const [incomeText, setIncomeText] = useState("");
  const [spendingText, setSpendingText] = useState("");
  const [targetText, setTargetText] = useState("");
  const [monthlyText, setMonthlyText] = useState("");
  const portfolio = portfolioAvailable ? roundedPortfolioMinor(portfolioTotal, currency) : null;
  const digits = liteCurrencyDigits(currency);
  const manual = parseLiteMoney(startText, currency);
  const start = source === "manual" ? manual.kind === "valid" ? manual.minor : null : portfolio;
  const income = parseLiteMoney(incomeText, currency);
  const spending = parseLiteMoney(spendingText, currency);
  const target = parseLiteMoney(targetText, currency);
  const monthly = parseLiteMoney(monthlyText, currency);
  const closing = start !== null && income.kind === "valid" && spending.kind === "valid" ? liteClosingAmount(start, income.minor, spending.minor) : null;
  const months = start !== null && target.kind === "valid" && monthly.kind === "valid" ? liteMonthsToTarget(start, target.minor, monthly.minor) : null;
  const needsContribution = start !== null && target.kind === "valid" && monthly.kind === "valid" && target.minor > start && months === null;

  return <section className={styles.panel} aria-labelledby="personal-lite-title">
    <div className={styles.heading}><div><p className={styles.eyebrow}>PERSONAL · PLAYGROUND</p><h2 id="personal-lite-title">Explore a simple plan.</h2></div><span className={styles.badge}>SESSION ONLY</span></div>
    <div className={styles.source}>
      <div><strong>Choose a starting amount</strong><p>No connected cash balance is available in this preview.</p></div>
      <p className={styles.sourceValue}>{currency}: {digits === null ? "currency precision unavailable" : digits === 0 ? "whole units only" : `up to ${digits} decimal places`}. Use a decimal point without thousands separators.</p>
      <div className={styles.sourceOptions} role="group" aria-label="Starting amount source">
        <button type="button" aria-pressed={source === "manual"} onClick={() => setSource("manual")}>Enter an amount</button>
        <button type="button" aria-pressed={source === "portfolio"} disabled={portfolio === null} onClick={() => setSource("portfolio")}>Use portfolio estimate</button>
      </div>
      {source === "manual" ? <MoneyField id="lite-start" label="Starting amount" value={startText} onChange={setStartText} currency={currency} /> : <p className={styles.sourceValue}>{portfolio === null ? "The complete portfolio estimate is unavailable." : `Rounded estimate: ${formatLiteMoney(portfolio, currency)}. This is not a cash balance.`}</p>}
      {source === "manual" && <p className={styles.sourceValue}>A portfolio estimate is optional and may include crypto value; it is not cash.</p>}
    </div>
    <div className={styles.calculators}>
      <section className={styles.calculator} aria-labelledby="lite-cashflow-title"><p className={styles.eyebrow}>CASH FLOW SCENARIO</p><h3 id="lite-cashflow-title">Plan what remains.</h3><div className={styles.fields}><MoneyField id="lite-income" label="Planned income" value={incomeText} onChange={setIncomeText} currency={currency} /><MoneyField id="lite-spending" label="Planned spending" value={spendingText} onChange={setSpendingText} currency={currency} /></div><div className={styles.result} aria-live="polite"><span>Scenario closing amount</span><strong>{closing === null ? "—" : formatLiteMoney(closing, currency)}</strong><small>{closing === null ? "Complete all three amounts to calculate." : "Starting amount + income − spending"}</small></div></section>
      <section className={styles.calculator} aria-labelledby="lite-savings-title"><p className={styles.eyebrow}>SAVINGS SCENARIO</p><h3 id="lite-savings-title">Set a target.</h3><div className={styles.fields}><MoneyField id="lite-target" label="Savings target" value={targetText} onChange={setTargetText} currency={currency} /><MoneyField id="lite-monthly" label="Monthly contribution" value={monthlyText} onChange={setMonthlyText} currency={currency} /></div><div className={styles.result} aria-live="polite"><span>Estimated time</span><strong>{months === null ? "—" : months === BigInt(0) ? "Target reached" : `${months.toString()} ${months === BigInt(1) ? "month" : "months"}`}</strong><small>{needsContribution ? "Enter a monthly contribution greater than zero." : "Assumes a fixed contribution, with no interest or returns."}</small></div></section>
    </div>
    <p className={styles.footnote}>Scenarios are hypothetical, not investment advice. Values reset when you leave Account, switch views, or change currency.</p>
  </section>;
}

export default function PersonalAccountingLite(props: Props) {
  return <Session key={props.currency} {...props} />;
}
