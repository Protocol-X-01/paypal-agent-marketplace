"use client";

import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { createCustomerSessionController, type CustomerSessionState } from "@/lib/customer-session-client";
import { createScopedStorage, type LocalDataStorage } from "@/lib/customer-session-storage";
import { createScopedEvents } from "@/lib/customer-session-events";
import { createShoppingDraftMemory } from "@/lib/customer-shopping-draft-memory";

const AUTH_SIGNAL = "paypal-markets-session-signal-v1";
const AUTH_RETURN = "paypal-markets-sign-in-return-v1";
const heldStorage: LocalDataStorage = { getItem() { throw new Error("Session not verified"); }, setItem() { throw new Error("Session not verified"); }, removeItem() { throw new Error("Session not verified"); } };
type PrivateScope = { ready: boolean; storage: LocalDataStorage; events: Pick<Window, "addEventListener" | "removeEventListener" | "dispatchEvent">; label: string };
type SessionContextValue = { state: CustomerSessionState; scope: PrivateScope; shoppingDraft: ReturnType<typeof createShoppingDraftMemory>; check: () => Promise<void>; logout: () => Promise<void>; beginSignIn: () => void };
const SessionContext = createContext<SessionContextValue | null>(null);

function signalOtherTabs(kind: "check" | "hold") {
  try {
    window.localStorage.setItem(AUTH_SIGNAL, JSON.stringify({ kind, nonce: crypto.randomUUID() }));
    window.localStorage.removeItem(AUTH_SIGNAL);
  } catch { /* Focus/page checks remain available when browser storage is blocked. */ }
}

export function CustomerSessionProvider({ children }: { children: ReactNode }) {
  const [controller] = useState(() => createCustomerSessionController({ notify: signalOtherTabs }));
  const [shoppingDraft] = useState(() => createShoppingDraftMemory(controller.getSnapshot));
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getServerSnapshot);
  const lease = state.lease;
  const scope = useMemo<PrivateScope>(() => ({
    ready: lease !== null && lease.active,
    storage: lease ? createScopedStorage(() => window.localStorage, lease) : heldStorage,
    events: createScopedEvents(() => window, lease),
    label: lease?.scope === "guest" ? "Guest data on this device" : lease ? "Your signed-in data on this device" : "Private data held until the session is verified",
  }), [lease]);

  useEffect(() => {
    const unsubscribeDraft = controller.subscribe(shoppingDraft.observe);
    shoppingDraft.observe();
    let hidden = document.visibilityState === "hidden";
    let returning = false;
    try { returning = window.sessionStorage.getItem(AUTH_RETURN) === "1"; window.sessionStorage.removeItem(AUTH_RETURN); } catch { /* No credentials or identity are stored in the marker. */ }
    void controller.check().then(() => { if (returning) signalOtherTabs(controller.getSnapshot().status === "ready" ? "check" : "hold"); });
    const onStorage = (event: StorageEvent) => {
      if (event.key !== AUTH_SIGNAL || !event.newValue) return;
      try { if (event.storageArea !== window.localStorage) return; const value: unknown = JSON.parse(event.newValue); if (value && typeof value === "object" && "kind" in value) { if (value.kind === "hold") controller.hold(); else if (value.kind === "check") void controller.check({ automatic: true }); } } catch { /* A malformed public signal never selects an identity. */ }
    };
    const onVisibility = () => { if (document.visibilityState === "hidden") hidden = true; else if (hidden) { hidden = false; void controller.check({ automatic: true }); } };
    const onPageShow = (event: PageTransitionEvent) => { if (event.persisted) void controller.check({ automatic: true }); };
    window.addEventListener("storage", onStorage);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", onPageShow);
    const timer = window.setInterval(() => { if (document.visibilityState === "visible" && controller.getSnapshot().status === "ready") void controller.check({ background: true, automatic: true }); }, 5 * 60_000);
    return () => { unsubscribeDraft(); shoppingDraft.clear(); window.clearInterval(timer); window.removeEventListener("storage", onStorage); document.removeEventListener("visibilitychange", onVisibility); window.removeEventListener("pageshow", onPageShow); controller.dispose(); };
  }, [controller, shoppingDraft]);

  const value: SessionContextValue = {
    state, scope, shoppingDraft, check: () => controller.check(), logout: controller.logout,
    beginSignIn() {
      try { window.sessionStorage.setItem(AUTH_RETURN, "1"); } catch { /* A full-page callback still verifies its session. */ }
      // A form attempt is not a new identity. Keep it mounted and preserve the
      // current verified view if a native beforeunload prompt cancels navigation.
      // The callback page verifies first, then asks other tabs to recheck.
    },
  };
  return <SessionContext value={value}>{children}</SessionContext>;
}

export function useCustomerSession() {
  const context = useContext(SessionContext);
  if (!context) throw new Error("Customer session provider is required");
  return context;
}

export function usePrivateDataScope() { return useCustomerSession().scope; }

export function useShoppingDraftMemory() {
  const { state, shoppingDraft } = useCustomerSession();
  return { lease: state.status === "ready" ? state.lease : null, shoppingDraft };
}

export function PrivateSessionNotice() {
  const { state, check, logout } = useCustomerSession();
  return <div className="notice session-held" role="status"><span>{state.status === "signing-out" ? "Confirming sign-out. Private data is hidden." : state.status === "uncertain" ? state.logoutUncertain ? "Sign-out could not be confirmed. Private data stays hidden." : "Your session could not be verified. Private data stays hidden; public markets remain available." : "Checking your session before loading saved data."}</span>{state.status === "uncertain" && <button type="button" onClick={() => { void (state.logoutUncertain ? logout() : check()); }}>{state.logoutUncertain ? "Retry sign-out" : "Check session again"}</button>}</div>;
}
