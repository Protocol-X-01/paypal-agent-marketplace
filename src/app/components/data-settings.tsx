"use client";

import { useEffect, useRef, useState } from "react";
import { STOREFRONT_STORAGE_KEY } from "@/lib/channel3-storefront";
import { MARKET_CURRENCIES, MARKET_CURRENCY_LABELS, isMarketCurrency, type MarketCurrency } from "@/lib/market-currency";
import { LOCAL_DATA_RESET_SIGNAL } from "@/lib/portfolio-input";
import { BUSINESS_PLAN_STORAGE_KEY } from "@/lib/business-plan-storage";
import { VENMO_CONTACTS_STORAGE_KEY } from "@/lib/venmo-contacts-web";
import { collectionLocksAvailable, SHOPPING_LISTS_STORAGE_KEY, tryCollectionLock } from "@/lib/collection-lock";
import { usePrivateDataScope, useShoppingDraftMemory } from "./customer-session";
import { useAppearance } from "./theme-preference";

const localData = [
  ["holdings", "paypal-markets-manual-holdings-v1"],
  ["watchlist", "paypal-markets-watchlist-v1"],
  ["shoppingLists", "paypal-markets-shopping-lists-v1"],
  ["displayCurrency", "paypal-markets-display-currency-v1"],
  ["shoppingStorefront", STOREFRONT_STORAGE_KEY],
  ["businessMonitoringPlan", BUSINESS_PLAN_STORAGE_KEY],
  ["venmoContacts", VENMO_CONTACTS_STORAGE_KEY],
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
  const { appearance, setAppearance } = useAppearance();
  const privateData = usePrivateDataScope();
  const { lease, shoppingDraft } = useShoppingDraftMemory();
  const localStorage = privateData.storage;
  const privateEvents = privateData.events;
  const [confirmReset, setConfirmReset] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const resetBusyRef = useRef(false);
  const resetBaseline = useRef<{ storage: typeof localStorage; value: string | null } | undefined>(undefined);
  const resetOperation = useRef(0);
  const resetIssued = useRef(false);
  const mounted = useRef(false);
  const activeStorage = useRef<typeof localStorage | null>(null);
  const [renderedStorage, setRenderedStorage] = useState(localStorage);
  const renderedResetBaseline = resetBaseline.current;

  // A new lease must never inherit a confirmation or result from the prior view.
  if (renderedStorage !== localStorage) {
    setRenderedStorage(localStorage);
    setConfirmReset(false);
    setResetBusy(false);
    setMessage("");
    setError(false);
  }

  useEffect(() => {
    mounted.current = true;
    activeStorage.current = localStorage;
    resetIssued.current = false;
    resetBusyRef.current = false;
    resetBaseline.current = undefined;
    return () => {
      mounted.current = false;
      activeStorage.current = null;
      resetBaseline.current = undefined;
      resetOperation.current += 1;
      resetBusyRef.current = false;
      resetIssued.current = false;
    };
  }, [localStorage]);

  function scopeIsCurrent() {
    if (!privateData.ready || !mounted.current || activeStorage.current !== localStorage) return false;
    try { return privateEvents.dispatchEvent(new Event("paypal-markets-scope-liveness")); } catch { return false; }
  }

  function exportData() {
    if (!scopeIsCurrent()) return;
    try {
      const data = Object.fromEntries(localData.map(([name, key]) => {
        const raw = localStorage.getItem(key);
        return [name, exportValue(raw)];
      }));
      if (!scopeIsCurrent()) return;
      const file = new Blob([JSON.stringify({ version: 2, view: privateData.label, exportedAt: new Date().toISOString(), data }, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(file);
      const link = document.createElement("a");
      link.href = url;
      link.download = "paypal-markets-local-data.json";
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      if (!scopeIsCurrent()) return;
      setMessage("Your local data export is ready in your downloads.");
      setError(false);
    } catch {
      if (!scopeIsCurrent()) return;
      setMessage("Your browser could not export the saved data. Check that local storage and downloads are allowed.");
      setError(true);
    }
  }

  function beginReset() {
    if (!scopeIsCurrent() || resetBusyRef.current || resetBaseline.current !== undefined) return;
    if (!collectionLocksAvailable()) {
      if (!scopeIsCurrent()) return;
      setMessage("Reset requires a secure browser that supports coordination between tabs. You can still export this local view.");
      setError(true);
      return;
    }
    try {
      const value = localStorage.getItem(SHOPPING_LISTS_STORAGE_KEY);
      if (!scopeIsCurrent()) return;
      resetBaseline.current = { storage: localStorage, value };
      setConfirmReset(true);
      setMessage("");
      setError(false);
    } catch {
      if (!scopeIsCurrent()) return;
      setMessage("Your browser could not check saved collections. Nothing was reset; export this local view or try again.");
      setError(true);
    }
  }

  function cancelReset() {
    if (!scopeIsCurrent() || !renderedResetBaseline || resetBaseline.current !== renderedResetBaseline) return;
    if (resetIssued.current) {
      setMessage("The reset has already started. Please wait for its result.");
      setError(true);
      return;
    }
    resetOperation.current += 1;
    resetBaseline.current = undefined;
    resetBusyRef.current = false;
    setResetBusy(false);
    setConfirmReset(false);
  }

  async function resetData() {
    if (!scopeIsCurrent() || resetBusyRef.current || !renderedResetBaseline || resetBaseline.current !== renderedResetBaseline || renderedResetBaseline.storage !== localStorage) return;
    const expected = resetBaseline.current.value;
    const operation = ++resetOperation.current;
    const current = () => mounted.current && resetOperation.current === operation;
    resetIssued.current = false;
    resetBusyRef.current = true;
    setResetBusy(true);
    let attempted = false;
    const locked = await tryCollectionLock(() => {
      if (!current()) return "cancelled" as const;
      let hadHoldings = false;
      try {
        if (localStorage.getItem(SHOPPING_LISTS_STORAGE_KEY) !== expected) return "changed" as const;
        hadHoldings = localStorage.getItem("paypal-markets-manual-holdings-v1") !== null;
        if (!current() || localStorage.getItem(SHOPPING_LISTS_STORAGE_KEY) !== expected) return "changed" as const;
        for (const [, key] of localData) {
          if (!current()) return "uncertain" as const;
          // Reset this tab's draft only when a removal is about to be issued.
          if (!attempted && shoppingDraft.write(lease, "") === "inactive") return "cancelled" as const;
          attempted = true;
          resetIssued.current = true;
          localStorage.removeItem(key);
        }
        return "reset" as const;
      } catch {
        return attempted ? "uncertain" as const : "unavailable" as const;
      } finally {
        if (attempted) {
          // Notify other views even when an issued removal threw after changing data.
          try { privateEvents.dispatchEvent(new Event("paypal-markets-data-reset")); } catch { /* Best effort; the user is told if reset was uncertain. */ }
          try {
            localStorage.setItem(LOCAL_DATA_RESET_SIGNAL, `${hadHoldings ? "removed-holdings" : "no-holdings"}:${Date.now()}-${Math.random()}`);
            localStorage.removeItem(LOCAL_DATA_RESET_SIGNAL);
          } catch { /* A blocked browser may prevent the cross-tab notice. */ }
        }
      }
    });
    if (!current()) return;
    // A revoked scope must not publish into the next customer's view.
    if (!scopeIsCurrent()) return;
    resetBusyRef.current = false;
    resetIssued.current = false;
    setResetBusy(false);
    const outcome = locked.kind === "acquired" ? locked.value : locked.kind;
    if (outcome === "reset") {
      resetBaseline.current = undefined;
      setConfirmReset(false);
      setMessage("Holdings, shopping lists, saved Venmo contacts, and the business monitoring plan were cleared. Your watchlist, display currency, and shopping storefront are back to their defaults.");
      setError(false);
    } else if (outcome === "changed") {
      resetBaseline.current = undefined;
      setConfirmReset(false);
      setMessage("Saved collections changed while you were reviewing this reset. Nothing was removed; review this local view and confirm again.");
      setError(true);
    } else if (outcome !== "cancelled") {
      if (outcome === "uncertain" || attempted) {
        resetBaseline.current = undefined;
        setConfirmReset(false);
      }
      setMessage(outcome === "uncertain" || attempted
        ? "The reset could not be verified and may be partial. Reload other open tabs and review or export your local data."
        : outcome === "busy"
          ? "Another collection change is in progress. Nothing was reset; try again."
          : "This browser could not coordinate the reset. Nothing was reset; you can still export this local view.");
      setError(true);
    }
  }

  return <section className="settings-page" aria-label="Data and privacy preferences">
    <article className="settings-card currency-settings">
      <p className="eyebrow">APPEARANCE</p>
      <h2>Choose your view.</h2>
      <div className="appearance-options" role="group" aria-label="Appearance mode">
        <button type="button" aria-pressed={appearance === "light"} onClick={() => setAppearance("light")}>Light mode</button>
        <button type="button" aria-pressed={appearance === "dark"} onClick={() => setAppearance("dark")}>Dark mode</button>
      </div>
      <div className="settings-divider" />
      <p className="eyebrow">DISPLAY PREFERENCES</p>
      <h2>Choose your currency.</h2>
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
      <p>{privateData.label}. Your entered crypto quantities, saved Venmo contacts, display currency, shopping storefront, market watchlist, shopping collections, and business monitoring plan stay in this local view. Sign-in separates entries by verified identity; it does not sync, migrate or back them up. Browser storage is not encrypted.</p>
      <div className="settings-actions"><button disabled={!privateData.ready} onClick={exportData}>Export this local view</button><button disabled={!privateData.ready || resetBusy} className="secondary-action" onClick={beginReset}>Reset this local view</button></div>
      {confirmReset && <div className="reset-confirmation" role="group" aria-label="Confirm local data reset">
        <h3>Reset this local view?</h3><p>This removes this view’s manual holdings, saved Venmo contacts, shopping collections and business plan, and restores its default preferences. Once the reset starts, an unfinished collection name in this tab is discarded even if the reset is interrupted. It also affects this local view in other open tabs and may discard unsaved work there. Other local views are left untouched. Export first if you want to keep a copy.</p>
        <div className="settings-actions"><button onClick={() => void resetData()} disabled={resetBusy}>{resetBusy ? "Checking…" : "Reset now"}</button><button className="secondary-action" onClick={cancelReset}>Cancel</button></div>
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
