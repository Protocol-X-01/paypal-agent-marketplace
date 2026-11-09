"use client";

import { useEffect, useState } from "react";
import { candleSelectionIdentity, isSupportedIntradaySelection, parseCandleHistory, parseIntradayCandleHistory, readCandleResponse, type CandleHistory, type CandleSelection } from "@/lib/web-candle-data";

type HistoryState = { key: string; status: "loading" } | { key: string; status: "error"; message?: string } | { key: string; status: "ready"; history: CandleHistory };
export type CandleHistoryRequest = ({ status: "idle" } | { status: "loading" } | { status: "error"; message?: string } | { status: "ready"; history: CandleHistory }) & { retry: () => void };

/** One request shared by price styles; ordinary line views with no indicators make none. */
export function useCandleHistory({ coinId, currency, days, intraday, enabled = true, refresh = 0 }: CandleSelection & { enabled?: boolean; refresh?: number }): CandleHistoryRequest {
  const [attempt, setAttempt] = useState(0);
  const identity = `${candleSelectionIdentity({ coinId, currency, days, intraday })}:${refresh}:${attempt}`;
  const [state, setState] = useState<HistoryState>({ key: identity, status: "loading" });
  const interval = intraday?.interval;
  const intradayDays = intraday?.days;
  const historyCurrency = intraday ? undefined : currency;
  const historyDays = intradayDays ?? days;
  const supported = !intraday || isSupportedIntradaySelection(coinId, intraday);

  useEffect(() => {
    if (!enabled || !supported) return;
    // Reuse this identity's completed result across price-style/visibility changes.
    // Retry and Refresh change the identity and deliberately request fresh history.
    if (state.key === identity && state.status !== "loading") return;
    const controller = new AbortController();
    let active = true;
    const timer = window.setTimeout(() => controller.abort(), 12_000);
    const minuteSelection = interval !== undefined ? { interval, days: historyDays as 1 | 7 } : undefined;
    const autoCurrency = historyCurrency ?? "USD";
    const url = minuteSelection ? `/api/market/intraday/${encodeURIComponent(coinId)}?interval=${minuteSelection.interval}&days=${minuteSelection.days}` : `/api/market/candles/${encodeURIComponent(coinId)}?days=${historyDays}&currency=${encodeURIComponent(autoCurrency)}`;
    let message: string | undefined = minuteSelection ? "Complete Binance candle history is unavailable for this window. No candles are filled or replaced." : undefined;
    fetch(url, { cache: "no-store", credentials: "same-origin", mode: "same-origin", redirect: "error", signal: controller.signal })
      .then((response) => {
        if (minuteSelection && !response.ok) message = response.status === 429 ? "Binance candle history is rate limited. Please wait before retrying." : "Complete Binance candle history is unavailable for this window. No candles are filled or replaced.";
        return readCandleResponse(response, controller.signal);
      })
      .then((data) => minuteSelection ? parseIntradayCandleHistory(data, { coinId, ...minuteSelection }) : parseCandleHistory(data, { coinId, currency: autoCurrency, days: historyDays }))
      .then((history) => { if (active) setState({ key: identity, status: "ready", history }); })
      .catch(() => { if (active) setState({ key: identity, status: "error", ...(message ? { message } : {}) }); })
      .finally(() => window.clearTimeout(timer));
    return () => { active = false; controller.abort(); window.clearTimeout(timer); };
  }, [coinId, historyCurrency, historyDays, interval, enabled, supported, identity, state]);

  const retry = () => setAttempt((value) => value + 1);
  if (!enabled) return { status: "idle", retry };
  if (!supported) return { status: "error", message: coinId === "paypal-usd" ? "Binance Spot candles are unavailable for PayPal USD. Choose Auto for CoinGecko history." : "This interval does not support that history window. Choose a 1-day window for 3m/5m or 7 days for 1d.", retry };
  if (state.key !== identity || state.status === "loading") return { status: "loading", retry };
  if (state.status === "error") return { status: "error", ...(state.message ? { message: state.message } : {}), retry };
  return { status: "ready", history: state.history, retry };
}
