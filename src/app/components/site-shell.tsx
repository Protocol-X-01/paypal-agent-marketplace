"use client";

import type { MouseEvent, ReactNode } from "react";
import Link from "next/link";
import { MARKET_CURRENCIES, MARKET_CURRENCY_LABELS, isMarketCurrency, type MarketCurrency } from "@/lib/market-currency";
import { formatMarketRetrievalTime } from "@/lib/market-format";
import styles from "./site-shell.module.css";
import type { DashboardSection } from "@/lib/account-experience";
import { useAppearance } from "./theme-preference";

export type SiteSection = DashboardSection;

export type SiteShellProps = {
  children: ReactNode;
  activeSection: string;
  onNavigate: (section: SiteSection) => void;
  refreshedAt?: string;
  refreshing?: boolean;
  onRefresh: () => void;
  currency: MarketCurrency;
  currencyReady: boolean;
  onCurrencyChange: (currency: MarketCurrency) => void;
  sessionControl?: ReactNode;
};

const sections: Array<{ id: SiteSection; label: string; mobileLabel: string }> = [
  { id: "overview", label: "Overview", mobileLabel: "Home" },
  { id: "markets", label: "Markets", mobileLabel: "Markets" },
  { id: "portfolio", label: "Portfolio", mobileLabel: "Portfolio" },
  { id: "account", label: "Account", mobileLabel: "Account" },
  { id: "shop", label: "Discover", mobileLabel: "Discover" },
  { id: "settings", label: "Preferences", mobileLabel: "Settings" },
];

function NavigationIcon({ section }: { section: SiteSection }) {
  const paths: Record<SiteSection, ReactNode> = {
    overview: <><rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1.5" /><rect x="14" y="3.5" width="6.5" height="6.5" rx="1.5" /><rect x="3.5" y="14" width="6.5" height="6.5" rx="1.5" /><rect x="14" y="14" width="6.5" height="6.5" rx="1.5" /></>,
    markets: <><path d="M4 4v16h16" /><path d="m7 14 4-4 4 3 5-7" /><path d="M16 6h4v4" /></>,
    portfolio: <><path d="M10 3.5a8.5 8.5 0 1 0 10.5 10.5H10Z" /><path d="M14 3.5V10h6.5A8.5 8.5 0 0 0 14 3.5Z" /></>,
    account: <><circle cx="12" cy="8" r="3.5" /><path d="M5 21v-2a7 7 0 0 1 14 0v2" /></>,
    shop: <><path d="M5 8h14l1.5 12h-17Z" /><path d="M8 8V6a4 4 0 0 1 8 0v2" /><path d="M8 12h.01M16 12h.01" /></>,
    settings: <><path d="M4 7h8m5 0h3M4 17h3m5 0h8" /><circle cx="14.5" cy="7" r="2.5" /><circle cx="9.5" cy="17" r="2.5" /></>,
  };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{paths[section]}</svg>;
}

function Brand({ mobile = false }: { mobile?: boolean }) {
  return (
    <Link href="/" className={`${styles.brand} ${mobile ? styles.mobileBrand : ""}`} aria-label="PayPal Markets website home">
      <span className={styles.brandSymbol} aria-hidden="true"><i /><i /></span>
      <span className={styles.brandWords}><span className={styles.wordmark}>PayPal<span>Markets</span></span>{mobile && <span className={styles.mobileConcept}>Website concept</span>}</span>
    </Link>
  );
}

export default function SiteShell({ children, activeSection, onNavigate, refreshedAt, refreshing = false, onRefresh, currency, currencyReady, onCurrencyChange, sessionControl }: SiteShellProps) {
  const { appearance, toggleAppearance } = useAppearance();
  const activeLabel = sections.find((section) => section.id === activeSection)?.label ?? "Overview";
  const refreshedTime = formatMarketRetrievalTime(refreshedAt);

  function navigate(event: MouseEvent<HTMLAnchorElement>, section: SiteSection) {
    // The parent records ordinary navigation in history; modified clicks keep
    // the anchor's native behavior for opening a section in another tab.
    if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      event.preventDefault();
      onNavigate(section);
    }
  }

  return (
    <div className={styles.shell}>
      <a className={styles.skipLink} href="#main-content">Skip to content</a>
      <aside className={styles.sidebar} aria-label="Workspace sidebar">
        <Brand />
        <p className={styles.railLabel}>Your workspace</p>
        <nav className={styles.desktopNavigation} aria-label="Main navigation">
          {sections.map((section) => (
            <a key={section.id} href={`#${section.id}`} onClick={(event) => navigate(event, section.id)}
              aria-current={activeSection === section.id ? "page" : undefined}
              className={`${styles.navigationLink} ${activeSection === section.id ? styles.activeLink : ""} ${section.id === "shop" ? styles.discoveryLink : ""} ${section.id === "settings" ? styles.preferencesLink : ""}`}>
              <span className={styles.navigationIcon}><NavigationIcon section={section.id} /></span>
              <span className={styles.navigationWords}><span>{section.label}</span></span>
              {section.id === "shop" && <span className={styles.discoveryArrow} aria-hidden="true">↗</span>}
            </a>
          ))}
        </nav>
        <div className={styles.railFooter}>
          <span className={styles.conceptBadge}>Website concept</span>
          <Link href="/">Visit the homepage <span aria-hidden="true">↗</span></Link>
        </div>
      </aside>

      <div className={styles.workspace}>
        <header className={styles.header}>
          <div className={styles.breadcrumb} aria-label="Current section"><span>Workspace</span><span aria-hidden="true">/</span><strong>{activeLabel}</strong></div>
          <div className={styles.mobileIdentity}><Brand mobile /></div>
          <div className={styles.headerActions}>
            {sessionControl}
            {refreshedTime && activeSection !== "account" && <span className={styles.updatedTime}>Snapshot retrieved <time dateTime={refreshedAt}>{refreshedTime}</time></span>}
            <button className={styles.appearanceButton} type="button" onClick={toggleAppearance}
              aria-label={`Switch to ${appearance === "dark" ? "light" : "dark"} mode`}
              title={`Switch to ${appearance === "dark" ? "light" : "dark"} mode`}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
                {appearance === "dark"
                  ? <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" /></>
                  : <path d="M20.5 15.4A8.5 8.5 0 0 1 8.6 3.5 8.5 8.5 0 1 0 20.5 15.4Z" />}
              </svg>
              <span>{appearance === "dark" ? "Light" : "Dark"}</span>
            </button>
            <select className={styles.currency} aria-label="Display currency" title={`Display currency: ${MARKET_CURRENCY_LABELS[currency]}`} value={currency} disabled={!currencyReady} onChange={(event) => {
              if (isMarketCurrency(event.currentTarget.value)) onCurrencyChange(event.currentTarget.value);
            }}>
              {MARKET_CURRENCIES.map((code) => <option key={code} value={code} aria-label={`${code} — ${MARKET_CURRENCY_LABELS[code]}`}>{code}</option>)}
            </select>
            <button className={styles.refreshButton} type="button" onClick={onRefresh} disabled={refreshing} aria-label="Refresh market reference prices and chart">
              <svg className={refreshing ? styles.spinning : undefined} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M20 7v5h-5M4 17v-5h5" /><path d="M5.3 7.4A8 8 0 0 1 18.6 6L20 8M4 16l1.4 2A8 8 0 0 0 18.7 16.6" /></svg>
              <span>{refreshing ? "Refreshing" : "Refresh prices"}</span>
            </button>
          </div>
        </header>
        <main id="main-content" className={styles.content} tabIndex={-1}>{children}</main>
      </div>

      <nav className={styles.mobileNavigation} aria-label="Mobile navigation">
        {sections.map((section) => (
          <a key={section.id} href={`#${section.id}`} onClick={(event) => navigate(event, section.id)} className={`${styles.mobileLink} ${activeSection === section.id ? styles.activeMobileLink : ""}`} aria-current={activeSection === section.id ? "page" : undefined}>
            <NavigationIcon section={section.id} />
            <span>{section.mobileLabel}</span>
          </a>
        ))}
      </nav>
    </div>
  );
}
