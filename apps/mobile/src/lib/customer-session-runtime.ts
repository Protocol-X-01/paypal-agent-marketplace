import { createCustomerSessionManager, type CustomerSessionManagerDependencies, type CustomerSessionManagerState } from './customer-session-manager';
import { createCustomerStorageFence } from './customer-storage-scope';
import type { CustomerSessionConfiguration } from './customer-session-config';
import type { CustomerSessionLinkConfig } from './customer-session-links';
export type CustomerLoginStatus = 'disabled' | 'checking' | 'available' | 'unavailable';
export type CustomerSessionRuntimeState = Readonly<{ session: CustomerSessionManagerState; loginStatus: CustomerLoginStatus; revision: number }>;
export type CustomerSessionRuntimeDependencies = {
  platform: string; configuration: CustomerSessionConfiguration; foreground: boolean;
  loadNative(config: CustomerSessionLinkConfig): Promise<CustomerSessionManagerDependencies>;
  presence(): Promise<'empty' | 'present' | 'unavailable'>;
  fence?: ReturnType<typeof createCustomerStorageFence>;
};
/** Runtime has no React/native imports. Fence invalidation precedes notification,
 * so stale callbacks lose their lease before UI reconciliation can run. */
export function createCustomerSessionRuntime(deps: CustomerSessionRuntimeDependencies) {
  const storageFence = deps.fence ?? createCustomerStorageFence();
  let state: CustomerSessionRuntimeState = Object.freeze({ session: Object.freeze({ status: 'holding' }), loginStatus: 'checking', revision: 0 });
  let manager: ReturnType<typeof createCustomerSessionManager> | undefined, unsubscribe: (() => void) | undefined;
  let availabilityClient: CustomerSessionManagerDependencies['client'] | undefined;
  let canStartSignIn: (() => boolean) | undefined;
  const browserSupported = () => { try { return !canStartSignIn || canStartSignIn(); } catch { return false; } };
  let availabilityGeneration = 0;
  let disposed = false, foreground = deps.foreground, initialization = 0;
  const listeners = new Set<(value: CustomerSessionRuntimeState) => void>();
  // The shared manager first holds every runtime and its leases without calling
  // observers; only then can any sign-out notification be delivered.
  function preparePrivacyHold() {
    if (disposed || state.session.status === 'holding') return;
    try { storageFence.invalidate(); }
    finally { state = Object.freeze({ session: Object.freeze({ status: 'holding' }), loginStatus: state.loginStatus, revision: state.revision + 1 }); }
  }
  function publish(session: CustomerSessionManagerState, loginStatus = state.loginStatus) {
    if (disposed) return;
    if (!foreground) session = Object.freeze({ status: 'holding' });
    const sameSession = session === state.session || (session.status !== 'authenticated' && session.status === state.session.status);
    if (!sameSession) storageFence.transition(session.status === 'authenticated' ? { kind: 'owner', dataScope: session.identity.dataScope } : { kind: session.status === 'guest' ? 'guest' : 'hold' });
    state = Object.freeze({ session, loginStatus, revision: state.revision + (sameSession ? 0 : 1) });
    for (const listener of listeners) { try { listener(state); } catch { /* Observer isolation. */ } }
  }
  async function initialize() {
    const epoch = ++initialization;
    publish({ status: 'holding' });
    if (deps.platform === 'web') { publish({ status: 'guest' }, 'disabled'); return; }
    try {
      if (deps.configuration.status !== 'ready') {
        const presence = await deps.presence();
        if (!disposed && epoch === initialization) publish({ status: presence === 'empty' ? 'guest' : 'holding' }, deps.configuration.status === 'disabled' ? 'disabled' : 'unavailable');
        return;
      }
      const native = await deps.loadNative(deps.configuration.links);
      if (disposed || epoch !== initialization) return;
      canStartSignIn = native.canStartSignIn;
      manager = createCustomerSessionManager(deps.configuration.links, { ...native, preparePrivacyHold });
      unsubscribe = manager.subscribe(value => publish(value));
      await manager.setForeground(foreground);
      if (!foreground) await manager.restore();
      availabilityClient = native.client;
      await refreshAvailability();
    } catch { if (!disposed && epoch === initialization) publish({ status: 'holding' }, 'unavailable'); }
  }
  async function refreshAvailability() {
    if (!availabilityClient || !manager) return;
    const epoch = ++availabilityGeneration;
    let available = false;
    try { available = browserSupported() && (await availabilityClient.availability()).loginAvailable; } catch { /* Availability never authorizes a workspace. */ }
    if (!disposed && epoch === availabilityGeneration) publish(manager.getState(), available ? 'available' : 'unavailable');
  }
  return {
    storageFence,
    getState: () => state,
    subscribe(listener: (value: CustomerSessionRuntimeState) => void) { listeners.add(listener); listener(state); return () => { listeners.delete(listener); }; },
    initialize,
    setForeground(active: boolean) {
      foreground = active;
      if (!active) publish({ status: 'holding' });
      return manager ? manager.setForeground(active) : active ? initialize() : Promise.resolve();
    },
    start: () => state.loginStatus === 'available' && foreground && browserSupported() ? manager?.start() ?? Promise.resolve() : Promise.resolve(),
    logout: () => manager?.logout() ?? Promise.resolve(),
    retry: async () => { if (!manager) return initialize(); await manager.restore(true); await refreshAvailability(); },
    dispose() { initialization++; availabilityGeneration++; unsubscribe?.(); manager?.dispose(); storageFence.invalidate(); disposed = true; listeners.clear(); },
  };
}
