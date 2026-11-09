import type { TrackedCoin } from "./market-assets";

export const LOCAL_DATA_RESET_SIGNAL = "paypal-markets-local-data-reset-signal-v1";
export type HoldingAmounts = Partial<Record<TrackedCoin, number>>;
export type HoldingDrafts = Partial<Record<TrackedCoin, string>>;
export type HoldingDraft =
  | { kind: "empty" }
  | { kind: "incomplete" }
  | { kind: "invalid"; reason?: "precision" }
  | { kind: "valid"; amount: number };

export type StorageSaveResult = { kind: "saved"; baseline: string | null } | { kind: "changed" } | { kind: "corrupt" } | { kind: "unavailable" };

/** Attempt one checked write; a failed write leaves the caller's pending state intact. */
export function saveBrowserSnapshot(
  storage: Pick<Storage, "getItem" | "setItem">,
  key: string,
  baseline: string | null,
  encoded: string,
  validate: (raw: string | null) => boolean,
  omitEmptyOnMissing = false,
): StorageSaveResult {
  let raw: string | null;
  try { raw = storage.getItem(key); } catch { return { kind: "unavailable" }; }
  try { if (!validate(raw)) return { kind: "corrupt" }; } catch { return { kind: "corrupt" }; }
  if (raw !== baseline) return { kind: "changed" };
  if (raw === encoded || (omitEmptyOnMissing && raw === null && encoded === "{}")) return { kind: "saved", baseline: raw };
  try { storage.setItem(key, encoded); } catch { return { kind: "unavailable" }; }
  return { kind: "saved", baseline: encoded };
}

export function mayClearStorageWarning(conflict: boolean, holdingsPending: boolean, watchlistPending: boolean, hasDrafts: boolean): boolean {
  return !conflict && !holdingsPending && !watchlistPending && !hasDrafts;
}

/** Compare decimal values independently of leading/trailing zeroes and exponent notation. */
function canonicalDecimal(value: string): string {
  const [coefficient, exponentText = "0"] = value.toLowerCase().split("e");
  const [whole, fraction = ""] = coefficient.split(".");
  const digits = `${whole}${fraction}`.replace(/^0+/, "");
  if (!digits) return "0";
  const significant = digits.replace(/0+$/, "");
  const exponent = Number(exponentText) - fraction.length + digits.length - significant.length;
  return `${significant}e${exponent}`;
}

/** Keep intermediate text and quantities that would be rounded out of storage. */
export function parseHoldingDraft(value: string): HoldingDraft {
  if (value === "") return { kind: "empty" };
  if (value.length > 128 || !/^(?:\d+(?:\.\d*)?|\.\d*)(?:[eE][+-]?\d*)?$/.test(value)) return { kind: "invalid" };
  if (value === "." || value.endsWith(".") || /[eE][+-]?$/.test(value)) return { kind: "incomplete" };
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0 || amount > 1e12) return { kind: "invalid" };
  // Reject positive input which underflows to zero instead of silently erasing it.
  if (amount === 0 && /[1-9]/.test(value.split(/[eE]/, 1)[0])) return { kind: "invalid" };
  // Snapshots store numbers. Require the number's shortest decimal representation
  // to preserve the value typed by the user, regardless of decimal notation.
  if (canonicalDecimal(value) !== canonicalDecimal(String(amount))) return { kind: "invalid", reason: "precision" };
  return { kind: "valid", amount };
}

/** Reject malformed snapshots wholesale so the original remains exportable. */
export function readStoredHoldings(raw: string | null, tracked: readonly TrackedCoin[]): { ok: true; amounts: HoldingAmounts } | { ok: false } {
  if (raw === null) return { ok: true, amounts: {} };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false };
    const allowed = new Set<string>(tracked);
    const entries = Object.entries(parsed);
    if (entries.some(([id, amount]) => !allowed.has(id) || typeof amount !== "number" || !Number.isFinite(amount) || amount < 0 || amount > 1e12)) return { ok: false };
    return { ok: true, amounts: Object.fromEntries(entries) as HoldingAmounts };
  } catch {
    return { ok: false };
  }
}

export function draftsForHoldings(amounts: HoldingAmounts): HoldingDrafts {
  return Object.fromEntries(Object.entries(amounts).map(([id, amount]) => [id, String(amount)])) as HoldingDrafts;
}

/** Reject unknown or malformed entries so their original browser data remains exportable. */
export function readStoredWatchlist(raw: string | null, tracked: readonly TrackedCoin[]): TrackedCoin[] {
  if (raw === null) return [...tracked];
  const parsed: unknown = JSON.parse(raw);
  const allowed = new Set<string>(tracked);
  if (!Array.isArray(parsed) || parsed.some((id) => typeof id !== "string" || !allowed.has(id)) || new Set(parsed).size !== parsed.length) {
    throw new Error("Invalid saved watchlist.");
  }
  const previousDefault = ["bitcoin", "ethereum", "solana"];
  if (parsed.length === previousDefault.length && previousDefault.every((id) => parsed.includes(id))) return [...tracked];
  return parsed as TrackedCoin[];
}

/** Retry the final reset notification if reading during the removal failed. */
export function handleResetStorageEvent(value: string | null, sawRemoval: { current: boolean }, reload: () => boolean): void {
  if (value === null) {
    sawRemoval.current = reload();
    return;
  }
  const alreadyReloaded = value.startsWith("removed-holdings:") && sawRemoval.current;
  sawRemoval.current = false;
  if (!alreadyReloaded) reload();
}

export function hasUnfinishedHoldings(drafts: HoldingDrafts): boolean {
  return Object.values(drafts).some((value) => {
    const draft = parseHoldingDraft(value);
    return draft.kind === "incomplete" || draft.kind === "invalid";
  });
}

/** Use complete drafts for an on-screen estimate without saving them. */
export function previewHoldings(drafts: HoldingDrafts, amounts: HoldingAmounts, tracked: readonly TrackedCoin[]): HoldingAmounts {
  const preview: HoldingAmounts = {};
  for (const id of tracked) {
    const value = drafts[id] ?? (amounts[id] === undefined ? "" : String(amounts[id]));
    const draft = parseHoldingDraft(value);
    if (draft.kind === "valid" && draft.amount > 0) preview[id] = draft.amount;
  }
  return preview;
}

export function sameHoldings(left: HoldingAmounts, right: HoldingAmounts): boolean {
  const leftEntries = Object.entries(left);
  return leftEntries.length === Object.keys(right).length && leftEntries.every(([id, amount]) =>
    Object.prototype.hasOwnProperty.call(right, id) && right[id as TrackedCoin] === amount,
  );
}
