"use client";

import { createContext, useCallback, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";

export type Appearance = "light" | "dark";

const APPEARANCE_STORAGE_KEY = "paypal-markets-theme-v1";

type AppearanceContextValue = {
  appearance: Appearance;
  setAppearance: (appearance: Appearance) => void;
  toggleAppearance: () => void;
};

const AppearanceContext = createContext<AppearanceContextValue | null>(null);

function isAppearance(value: string | null): value is Appearance {
  return value === "light" || value === "dark";
}

const listeners = new Set<() => void>();

function getAppearanceSnapshot(): Appearance {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function getServerAppearanceSnapshot(): Appearance {
  return "dark";
}

function notifyAppearanceChange() {
  for (const listener of listeners) listener();
}

function applyAppearance(appearance: Appearance) {
  document.documentElement.dataset.theme = appearance;
  document.documentElement.style.colorScheme = appearance;
  try {
    window.localStorage.setItem(APPEARANCE_STORAGE_KEY, appearance);
  } catch {
    // Keep the current page preference even when browser persistence is unavailable.
  }
  notifyAppearanceChange();
}

function subscribeToAppearance(listener: () => void) {
  if (typeof window === "undefined") return () => {};

  listeners.add(listener);
  const handleStorage = (event: StorageEvent) => {
    if (event.key !== APPEARANCE_STORAGE_KEY && event.key !== null) return;
    const next = isAppearance(event.newValue) ? event.newValue : "dark";
    document.documentElement.dataset.theme = next;
    document.documentElement.style.colorScheme = next;
    notifyAppearanceChange();
  };
  window.addEventListener("storage", handleStorage);

  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", handleStorage);
  };
}

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const appearance = useSyncExternalStore(
    subscribeToAppearance,
    getAppearanceSnapshot,
    getServerAppearanceSnapshot,
  );

  const setAppearance = useCallback((next: Appearance) => {
    applyAppearance(next);
  }, []);

  const toggleAppearance = useCallback(() => {
    setAppearance(appearance === "dark" ? "light" : "dark");
  }, [appearance, setAppearance]);

  const value = useMemo(() => ({ appearance, setAppearance, toggleAppearance }), [appearance, setAppearance, toggleAppearance]);
  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

export function useAppearance() {
  const value = useContext(AppearanceContext);
  if (!value) throw new Error("useAppearance must be used inside AppearanceProvider");
  return value;
}

export const appearanceStorageKey = APPEARANCE_STORAGE_KEY;
