"use client";

import type { TrackedCoin } from "@/lib/market-assets";
import { supportsIntradayWindow, type CandleIntervalChoice, type IntradayDays } from "@/lib/web-candle-data";
import styles from "./candle-feed-controls.module.css";

export default function CandleFeedControls({ coinId, interval, days, onIntervalChange, onDaysChange }: {
  coinId: TrackedCoin; interval: CandleIntervalChoice; days: IntradayDays;
  onIntervalChange: (value: CandleIntervalChoice) => void; onDaysChange: (value: IntradayDays) => void;
}) {
  const minute = interval !== "auto";
  return <div className={styles.controls}>
    <div className={styles.groups}>
      <div className={styles.group}><span>Candle interval</span><div role="group" aria-label="Candle interval and source">
        {(["auto", "3m", "5m", "15m", "30m", "1h", "4h", "1d"] as const).map((choice) => <button key={choice} type="button" aria-pressed={interval === choice} disabled={coinId === "paypal-usd" && choice !== "auto"} onClick={() => onIntervalChange(choice)}>{choice === "auto" ? "Auto · CoinGecko" : choice}</button>)}
      </div></div>
      {minute && <div className={styles.group}><span>History window</span><div role="group" aria-label="Candle history window">
        <button type="button" aria-pressed={days === 1} disabled={!supportsIntradayWindow(interval, 1)} onClick={() => onDaysChange(1)}>1 day</button>
        <button type="button" aria-pressed={days === 7} disabled={!supportsIntradayWindow(interval, 7)} onClick={() => onDaysChange(7)}>7 days</button>
      </div></div>}
    </div>
    <p className={styles.note}>{coinId === "paypal-usd" ? "PayPal USD uses Auto CoinGecko history; Binance Spot has no PYUSD pair." : minute ? "Binance Spot · USDT, separate from USD · closed candles only. 3m/5m use 1D; 1d uses 7D." : "Auto uses CoinGecko’s interval for the selected range. Binance Spot uses a separate USDT feed."}</p>
  </div>;
}
