import type { CustomerSession } from "./customer-session-client";

export type AccountExperience = "personal" | "business";
export type DashboardSection = "overview" | "markets" | "portfolio" | "account" | "shop" | "settings";

/** A provider type chooses presentation only; unknown identity/type never invents one. */
export function initialAccountExperience(session: CustomerSession | null): AccountExperience | null {
  if (!session) return null;
  if (!session.authenticated) return "personal";
  return session.accountType === "unknown" ? null : session.accountType;
}

/** Keep old Business bookmarks while exposing a single customer Account entry. */
export function dashboardLocation(hash: string, hasProductSearch: boolean): { section: DashboardSection; businessBookmark: boolean } {
  const section = hash.replace(/^#/, "");
  if (section === "business") return { section: "account", businessBookmark: true };
  if (["overview", "markets", "portfolio", "account", "shop", "settings"].includes(section)) return { section: section as DashboardSection, businessBookmark: false };
  return { section: hasProductSearch ? "shop" : "overview", businessBookmark: false };
}
