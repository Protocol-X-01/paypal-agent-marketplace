"use client";

import { useState } from "react";

const localData = [
  ["holdings", "paypal-markets-manual-holdings-v1"],
  ["watchlist", "paypal-markets-watchlist-v1"],
  ["shoppingLists", "paypal-markets-shopping-lists-v1"],
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

export default function DataSettings() {
  const [confirmReset, setConfirmReset] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);

  function exportData() {
    try {
      const data = Object.fromEntries(localData.map(([name, key]) => {
        const raw = localStorage.getItem(key);
        return [name, exportValue(raw)];
      }));
      const file = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), data }, null, 2)], { type: "application/json" });
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
    try {
      for (const [, key] of localData) localStorage.removeItem(key);
      window.dispatchEvent(new Event("paypal-markets-data-reset"));
      setConfirmReset(false);
      setMessage("Holdings and shopping lists were cleared. Your watchlist is back to its defaults.");
      setError(false);
    } catch {
      setMessage("Your browser could not complete the reset. Some saved information may remain.");
      setError(true);
    }
  }

  return <section className="settings-page" aria-label="Data and privacy preferences">
    <article className="settings-card">
      <p className="eyebrow">SAVED IN YOUR BROWSER</p>
      <h2>Keep control of your information.</h2>
      <p>Your entered crypto quantities, market watchlist, and shopping collections are saved on this device. They are not synced to an account or backed up by this website.</p>
      <div className="settings-actions"><button onClick={exportData}>Export my data</button><button className="secondary-action" onClick={() => { setConfirmReset(true); setMessage(""); }}>Reset local data</button></div>
      {confirmReset && <div className="reset-confirmation" role="group" aria-label="Confirm local data reset">
        <h3>Reset this browser?</h3><p>This removes your manual holdings and shopping collections and restores the default watchlist. Export first if you want to keep a copy.</p>
        <div className="settings-actions"><button onClick={resetData}>Reset now</button><button className="secondary-action" onClick={() => setConfirmReset(false)}>Cancel</button></div>
      </div>}
      {message && <p className={error ? "settings-message is-error" : "settings-message"} role="status">{message}</p>}
    </article>
    <article className="settings-card">
      <p className="eyebrow">HOW THIS EXPERIENCE WORKS</p><h2>Know where your information goes.</h2>
      <dl className="data-sources">
        <div><dt>Market prices</dt><dd>CoinGecko supplies market metrics and price history. Your entered holdings are calculated in this browser and are not sent with market requests.</dd></div>
        <div><dt>Product discovery</dt><dd>Your submitted search phrase is sent to Channel3 to retrieve products and offers. Saved shopping collections stay in this browser.</dd></div>
        <div><dt>Wallet and payments</dt><dd>No payment account is connected to this concept. Continue to manage money in your existing wallet or payment app.</dd></div>
        <div><dt>Retailer offers</dt><dd>Opening an offer takes you to an external website. Review its current price, availability, and checkout terms there.</dd></div>
      </dl>
    </article>
  </section>;
}
