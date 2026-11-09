import type { CustomerSessionState } from "./customer-session-client";
import type { ScopeLease } from "./customer-session-storage";

// Keep ordinary pasted drafts intact while bounding per-tab memory.
export const MAX_RETAINED_COLLECTION_DRAFT_LENGTH = 10_000;

type Draft = { scope: ScopeLease["scope"]; value: string };

/** Per-provider memory; never stored, logged, or shared with another tab. */
export function createShoppingDraftMemory(getSession: () => CustomerSessionState) {
  let draft: Draft | null = null;

  function isCurrent(lease: ScopeLease | null): lease is ScopeLease {
    const current = getSession();
    return lease !== null && lease.active && current.status === "ready" && current.lease === lease;
  }

  return {
    read(lease: ScopeLease | null): string | null {
      return isCurrent(lease) && draft?.scope === lease.scope ? draft.value : null;
    },
    write(lease: ScopeLease | null, value: string): "retained" | "too-long" | "inactive" {
      if (!isCurrent(lease)) return "inactive";
      if (value.length > MAX_RETAINED_COLLECTION_DRAFT_LENGTH) { draft = null; return "too-long"; }
      draft = value ? { scope: lease.scope, value } : null;
      return "retained";
    },
    observe() {
      const current = getSession();
      if (current.status === "checking") return;
      if (current.status !== "ready" || !current.lease.active || (draft && current.lease.scope !== draft.scope)) draft = null;
    },
    clear() { draft = null; },
  };
}
