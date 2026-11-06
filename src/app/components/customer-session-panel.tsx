"use client";

import { useEffect, useState } from "react";
import type { AccountExperience } from "@/lib/account-experience";
import { PrivateSessionNotice, useCustomerSession } from "./customer-session";
import styles from "./customer-session-panel.module.css";

export function SessionHeaderControl({ onAccount }: { onAccount: () => void }) {
  const { state } = useCustomerSession();
  const label = state.status === "ready" ? state.session.authenticated ? "Signed in" : "Guest" : state.status === "uncertain" ? "Session unverified" : state.status === "signing-out" ? "Signing out" : "Checking session";
  return <button type="button" className={styles.headerControl} onClick={onAccount} aria-label={`Account · ${label}`}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="12" cy="8" r="3.5" /><path d="M5 21v-2a7 7 0 0 1 14 0v2" /></svg><span>Account<small>{label}</small></span></button>;
}

export function AccountSessionPanel({ experience, onChoose }: { experience: AccountExperience | null; onChoose: (next: AccountExperience) => void }) {
  const { state, beginSignIn, logout } = useCustomerSession();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setFailed(new URLSearchParams(window.location.search).get("auth") === "failed"), 0);
    return () => window.clearTimeout(timer);
  }, []);
  if (state.status !== "ready") return <section className={styles.card} aria-label="Account session"><PrivateSessionNotice /><p className={styles.detail}>Saved data remains on this device. A session check must complete before private views or editing resume.</p></section>;
  const signedIn = state.session.authenticated;
  const type = signedIn ? state.session.accountType : null;
  return <section className={styles.card} aria-label="Account session">
    {failed && <p className={styles.failure} role="status">Sign-in did not complete. The verified session status below determines which local view is available.</p>}
    <div className={styles.heading}><div><p className={styles.eyebrow}>{signedIn ? "VERIFIED APPLICATION SESSION" : "GUEST PREVIEW"}</p><h2>{signedIn ? "Signed in with PayPal." : "Your local preview, with a clear boundary."}</h2></div><span className={styles.badge}>{signedIn ? "Signed in" : "Guest"}</span></div>
    <p className={styles.intro}>{signedIn ? "Your saved browser data is separated for this verified identity. Guest entries stay in their original space; nothing has been migrated or synced." : "Explore the Personal and Business layouts using this device’s guest entries. Sign in when available to use a separate local space for your verified identity."}</p>
    <div className={styles.actions}>{signedIn ? <button type="button" className={styles.secondary} onClick={() => { void logout(); }}>Sign out of this app</button> : <>{state.session.loginAvailable ? <form action="/api/auth/paypal/start" method="post" onSubmit={beginSignIn}><button type="submit" className={styles.primary}>Continue with PayPal <span aria-hidden="true">↗</span></button></form> : <p className={styles.availability}>PayPal sign-in is currently unavailable. The guest preview remains available.</p>}<button type="button" className={styles.secondary} onClick={() => { void logout(); }}>Reset app sign-in</button></>}</div>
    {!signedIn && <p className={styles.detail}>If an older sign-in is preventing a new attempt, reset app sign-in to clear its session cookies. Saved local entries and PayPal consent are unchanged.</p>}
    {signedIn && <p className={styles.detail}>{type === "unknown" ? "PayPal did not confirm an account type. Choose a local presentation below." : `PayPal reports a ${type === "business" ? "Business" : "Personal"} account type, used only for the initial presentation.`} Sign-in and presentation choices do not grant payment, wallet or reporting permissions.</p>}
    {signedIn && type === "unknown" && experience === null && <div className={styles.choice} role="group" aria-label="Choose a local account presentation"><button type="button" onClick={() => onChoose("personal")}>Personal presentation</button><button type="button" onClick={() => onChoose("business")}>Business presentation</button></div>}
    <p className={styles.footnote}>Holdings are manual estimates. Saved entries remain device-local and separate by identity; guest entries are preserved. Sign-out, an identity change or an unverified session clears unsaved imports and drafts.</p>
  </section>;
}
