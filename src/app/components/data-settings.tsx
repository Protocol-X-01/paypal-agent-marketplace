"use client";

import { useState } from "react";
import { STOREFRONT_STORAGE_KEY } from "@/lib/channel3-storefront";
import { MARKET_CURRENCIES, MARKET_CURRENCY_LABELS, isMarketCurrency, type MarketCurrency } from "@/lib/market-currency";
import { LOCAL_DATA_RESET_SIGNAL } from "@/lib/portfolio-input";
import { BUSINESS_PLAN_STORAGE_KEY } from "@/lib/business-plan-storage";
import { usePrivateDataScope } from "./customer-session";

const localData = [
  ["holdings", "paypal-markets-manual-holdings-v1"],
  ["watchlist", "paypal-markets-watchlist-v1"],
  ["shoppingLists", "paypal-markets-shopping-lists-v1"],
  ["displayCurrency", "paypal-markets-display-currency-v1"],
  ["shoppingStorefront", STOREFRONT_STORAGE_KEY],
  ["businessMonitoringPlan", BUSINESS_PLAN_STORAGE_KEY],
] as const;

function exportValue(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // Keep malformed browser data recoverable instead of making export fail.
    return { format: "unparsed-local-value", raw };
  }
}

export default function DataSettings({ currency, currencyReady, onCurrencyChange }: { currency: MarketCurrency; currencyReady: boolean; onCurrencyChange: (currency: MarketCurrency) => void }) {
  const privateData = usePrivateDataScope();
  const localStorage = privateData.storage;
  const privateEvents = privateData.events;
  const [confirmReset, setConfirmReset] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);

  function exportData() {
    if (!privateData.ready) return;
    try {
      const data = Object.fromEntries(localData.map(([name, key]) => {
        const raw = localStorage.getItem(key);
        return [name, exportValue(raw)];
      }));
      const file = new Blob([JSON.stringify({ version: 2, view: privateData.label, exportedAt: new Date().toISOString(), data }, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(file);
      const link = document.createElement("a");
      link.href = url;
      link.download = "paypal-markets-local-data.json";
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage("Your local data export is ready in your downloads.");
      setError(false);
    } catch {
      setMessage("Your browser could not export the saved data. Check that local storage and downloads are allowed.");
      setError(true);
    }
  }

  function resetData() {
    if (!privateData.ready) return;
    try {
      const hadHoldings = localStorage.getItem("paypal-markets-manual-holdings-v1") !== null;
      for (const [, key] of localData) localStorage.removeItem(key);
      privateEvents.dispatchEvent(new Event("paypal-markets-data-reset"));
      // Emit a transient storage event even if the reset keys were already absent.
      localStorage.setItem(LOCAL_DATA_RESET_SIGNAL, `${hadHoldings ? "removed-holdings" : "no-holdings"}:${Date.now()}-${Math.random()}`);
      localStorage.removeItem(LOCAL_DATA_RESET_SIGNAL);
      setConfirmReset(false);
      setMessage("Holdings, shopping lists, and the business monitoring plan were cleared. Your watchlist, display currency, and shopping storefront are back to their defaults.");
      setError(false);
    } catch {
      setMessage("Your browser could not complete the reset. Some saved information may remain.");
      setError(true);
    }
  }

  return <section className="settings-page" aria-label="Data and privacy preferences">
    <article className="settings-card currency-settings">
      <p className="eyebrow">DISPLAY PREFERENCES</p>
      <h2>Choose your currency.</h2>
      <p>Market prices, charts, and your portfolio estimate use this display currency. The choice is saved in this browser.</p>
      <label htmlFor="display-currency">Display currency</label>
      <select id="display-currency" value={currency} disabled={!currencyReady} onChange={(event) => {
        if (isMarketCurrency(event.currentTarget.value)) onCurrencyChange(event.currentTarget.value);
      }}>
        {MARKET_CURRENCIES.map((code) => <option key={code} value={code}>{code} — {MARKET_CURRENCY_LABELS[code]}</option>)}
      </select>
      <p>Retailer offers and Venmo drafts keep their stated currencies.</p>
    </article>
    <article className="settings-card">
      <p className="eyebrow">SAVED IN YOUR BROWSER</p>
      <h2>Keep control of your information.</h2>
      <p>{privateData.label}. Your entered crypto quantities, display currency, shopping storefront, market watchlist, shopping collections, and business monitoring plan stay in this local view. Sign-in separates entries by verified identity; it does not sync, migrate or back them up.</p>
      <div className="settings-actions"><button disabled={!privateData.ready} onClick={exportData}>Export this local view</button><button disabled={!privateData.ready} className="secondary-action" onClick={() => { setConfirmReset(true); setMessage(""); }}>Reset this local view</button></div>
      {confirmReset && <div className="reset-confirmation" role="group" aria-label="Confirm local data reset">
        <h3>Reset this local view?</h3><p>This removes this view’s manual holdings, shopping collections and business plan, and restores its default preferences. Other local views are left untouched. Export first if you want to keep a copy.</p>
        <div className="settings-actions"><button onClick={resetData}>Reset now</button><button className="secondary-action" onClick={() => setConfirmReset(false)}>Cancel</button></div>
      </div>}
      {message && <p className={error ? "settings-message is-error" : "settings-message"} role="status">{message}</p>}
    </article>
    <article className="settings-card">
      <p className="eyebrow">HOW THIS EXPERIENCE WORKS</p><h2>Know where your information goes.</h2>
      <dl className="data-sources">
        <div><dt>Market prices</dt><dd>CoinGecko supplies market metrics and price history. Your entered holdings are calculated in this browser and are not sent with market requests.</dd></div>
        <div><dt>Product discovery</dt><dd>Your submitted search phrase is sent to Channel3 to retrieve products and offers. Saved shopping collections stay in this browser.</dd></div>
        <div><dt>Wallet and payments</dt><dd>Application sign-in identifies a customer; it does not connect balances or grant payment permissions. Continue to manage money in your existing wallet or payment app.</dd></div>
        <div><dt>Retailer offers</dt><dd>Opening an offer takes you to an external website. Review its current price, availability, and checkout terms there.</dd></div>
      </dl>
    </article>
  </section>;
}
