"use client";

import type { TrackedCoin } from "@/lib/market-assets";
import type { CandleIntervalChoice, IntradayDays } from "@/lib/web-candle-data";
import styles from "./candle-feed-controls.module.css";

export default function CandleFeedControls({ coinId, interval, days, onIntervalChange, onDaysChange }: {
  coinId: TrackedCoin; interval: CandleIntervalChoice; days: IntradayDays;
  onIntervalChange: (value: CandleIntervalChoice) => void; onDaysChange: (value: IntradayDays) => void;
}) {
  const minute = interval !== "auto";
  return <div className={styles.controls}>
    <div className={styles.groups}>
      <div className={styles.group}><span>Candle interval</span><div role="group" aria-label="Candle interval and source">
        {(["auto", "3m", "5m", "15m"] as const).map((choice) => <button key={choice} type="button" aria-pressed={interval === choice} disabled={coinId === "paypal-usd" && choice !== "auto"} onClick={() => onIntervalChange(choice)}>{choice === "auto" ? "Auto · CoinGecko" : choice}</button>)}
      </div></div>
      {minute && <div className={styles.group}><span>Intraday window</span><div role="group" aria-label="Intraday history window">
        <button type="button" aria-pressed={days === 1} onClick={() => onDaysChange(1)}>1 day</button>
        <button type="button" aria-pressed={days === 7} disabled={interval !== "15m"} onClick={() => onDaysChange(7)}>7 days · 15m only</button>
      </div></div>}
    </div>
    <p className={styles.note}>{coinId === "paypal-usd" ? "PayPal USD uses Auto CoinGecko history; this minute feed has no PYUSD pair." : minute ? "Binance Spot · USDT quote, separate from USD. 3m and 5m support 1 day; 15m supports 1 or 7 days. Complete trade candles only." : "Auto uses CoinGecko’s interval for the selected range. Minute candles use a separate USDT exchange feed and window."}</p>
  </div>;
}
