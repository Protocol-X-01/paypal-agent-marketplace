import { createScopeLease, revokeScopeLease, type ScopeLease } from "./customer-session-storage";

export type CustomerSession = { authenticated: false; loginAvailable: boolean } | { authenticated: true; loginAvailable: boolean; accountType: "personal" | "business" | "unknown"; dataScope: `v1_${string}` };
export type CustomerSessionState = { status: "checking" | "signing-out" | "uncertain"; epoch: number; lease: null; session: null; logoutUncertain?: boolean } | { status: "ready"; epoch: number; lease: ScopeLease; session: CustomerSession };
const MAX_SESSION_BYTES = 8192;

export function parseCustomerSession(value: unknown): CustomerSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid session response");
  const session = value as Record<string, unknown>;
  if (typeof session.loginAvailable !== "boolean") throw new Error("Invalid session availability");
  if (session.authenticated === false && Object.keys(session).every((key) => key === "authenticated" || key === "loginAvailable")) return { authenticated: false, loginAvailable: session.loginAvailable };
  if (session.authenticated === true && ["personal", "business", "unknown"].includes(String(session.accountType)) && typeof session.dataScope === "string" && /^v1_[A-Za-z0-9_-]{43}$/.test(session.dataScope) && Object.keys(session).every((key) => ["authenticated", "loginAvailable", "accountType", "dataScope"].includes(key))) {
    return { authenticated: true, loginAvailable: session.loginAvailable, accountType: session.accountType as "personal" | "business" | "unknown", dataScope: session.dataScope as `v1_${string}` };
  }
  throw new Error("Invalid session identity");
}

async function readSessionResponse(response: Response, signal: AbortSignal): Promise<CustomerSession> {
  if (response.status !== 200 || !response.headers.get("cache-control")?.split(",").some((part) => part.trim().toLowerCase() === "no-store") || !response.headers.get("content-type")?.toLowerCase().startsWith("application/json") || !response.body) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error("Session could not be verified");
  }
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_SESSION_BYTES)) { void response.body.cancel().catch(() => undefined); throw new Error("Invalid session size"); }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let finished = false;
  try {
    while (true) {
      const part = await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
        const aborted = () => { signal.removeEventListener("abort", aborted); reject(new Error("Session request aborted")); };
        if (signal.aborted) { aborted(); return; }
        signal.addEventListener("abort", aborted, { once: true });
        reader.read().then((value) => { signal.removeEventListener("abort", aborted); resolve(value); }, (error: unknown) => { signal.removeEventListener("abort", aborted); reject(error); });
      });
      if (part.done) { finished = true; break; }
      length += part.value.byteLength;
      if (length > MAX_SESSION_BYTES) throw new Error("Session response too large");
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return parseCustomerSession(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown);
  } finally {
    if (!finished) void reader.cancel().catch(() => undefined);
    try { reader.releaseLock(); } catch { /* A canceled read can still be settling. */ }
  }
}

export function createCustomerSessionController({ fetcher = fetch, notify = () => undefined }: { fetcher?: typeof fetch; notify?: (kind: "check" | "hold") => void } = {}) {
  let state: CustomerSessionState = { status: "checking", epoch: 0, lease: null, session: null };
  const initial = state;
  const listeners = new Set<() => void>();
  let generation = 0;
  let request: AbortController | null = null;
  const publish = (next: CustomerSessionState) => { state = next; for (const listener of listeners) listener(); };
  const suspend = (status: "checking" | "signing-out" | "uncertain", logoutUncertain = false) => {
    generation++;
    request?.abort(); request = null;
    revokeScopeLease(state.lease);
    publish({ status, epoch: state.epoch + 1, lease: null, session: null, logoutUncertain });
    return generation;
  };
  async function check({ background = false, automatic = false }: { background?: boolean; automatic?: boolean } = {}) {
    if (state.status === "signing-out" || (automatic && state.status === "uncertain" && state.logoutUncertain)) return;
    const retained = background && state.status === "ready" ? state : null;
    const current = retained ? (++generation) : suspend("checking");
    if (retained) request?.abort();
    const controller = new AbortController();
    request = controller;
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetcher("/api/auth/session", { cache: "no-store", credentials: "same-origin", redirect: "error", signal: controller.signal });
      const session = await readSessionResponse(response, controller.signal);
      if (current !== generation || controller.signal.aborted) return;
      const scope = session.authenticated ? session.dataScope : "guest";
      if (retained && retained.lease.active && retained.lease.scope === scope) publish({ ...retained, session });
      else { revokeScopeLease(retained?.lease ?? null); publish({ status: "ready", epoch: state.epoch + 1, lease: createScopeLease(scope, `session-${current}`), session }); }
    } catch { if (current === generation) { revokeScopeLease(retained?.lease ?? null); publish({ status: "uncertain", epoch: state.epoch + 1, lease: null, session: null }); } }
    finally { clearTimeout(timer); if (request === controller) request = null; }
  }
  async function logout() {
    const current = suspend("signing-out");
    notify("hold");
    const controller = new AbortController();
    request = controller;
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetcher("/api/auth/logout", { method: "POST", cache: "no-store", credentials: "same-origin", redirect: "error", signal: controller.signal });
      void response.body?.cancel().catch(() => undefined);
      if (current !== generation || controller.signal.aborted) return;
      if (response.status !== 204) throw new Error("Sign-out could not be confirmed");
      publish({ status: "checking", epoch: state.epoch + 1, lease: null, session: null });
      await check();
      notify(state.status === "ready" ? "check" : "hold");
    } catch { if (current === generation) publish({ status: "uncertain", epoch: state.epoch + 1, lease: null, session: null, logoutUncertain: true }); }
    finally { clearTimeout(timer); if (request === controller) request = null; }
  }
  return {
    getSnapshot: () => state,
    getServerSnapshot: () => initial,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    check, logout,
    hold() { if (state.status !== "signing-out" && !(state.status === "uncertain" && state.logoutUncertain)) suspend("uncertain"); },
    dispose() { generation++; request?.abort(); request = null; revokeScopeLease(state.lease); },
  };
}
