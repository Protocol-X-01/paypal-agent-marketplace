import { decodeScopeStorageKey, type ScopeLease } from "./customer-session-storage";

/** Scope storage events and transient local notices without broadcasting private values. */
export function createScopedEvents(getWindow: () => Window, lease: ScopeLease | null): Pick<Window, "addEventListener" | "removeEventListener" | "dispatchEvent"> {
  type Listener = EventListenerOrEventListenerObject;
  const wrapped = new Map<string, Map<Listener, EventListener>>();
  const isPrivate = (type: string) => type === "storage" || type.startsWith("paypal-markets-");
  const actualType = (type: string) => type.startsWith("paypal-markets-") ? `${type}:${lease?.id ?? "held"}` : type;
  const invoke = (listener: Listener, event: Event) => typeof listener === "function" ? listener(event) : listener.handleEvent(event);
  return {
    addEventListener: ((type: string, listener: Listener | null, options?: boolean | AddEventListenerOptions) => {
      if (!listener || (isPrivate(type) && !lease?.active)) return;
      const handler: EventListener = (event) => {
        if (isPrivate(type) && !lease?.active) return;
        if (type === "storage") {
          const change = event as StorageEvent;
          try { if (change.storageArea !== getWindow().localStorage || !lease) return; } catch { return; }
          const key = decodeScopeStorageKey(lease, change.key);
          if (key === undefined) return;
          invoke(listener, { key, oldValue: change.oldValue, newValue: change.newValue, storageArea: change.storageArea, url: change.url } as StorageEvent);
        } else invoke(listener, event);
      };
      const listeners = wrapped.get(type) ?? new Map<Listener, EventListener>();
      listeners.set(listener, handler); wrapped.set(type, listeners);
      getWindow().addEventListener(actualType(type), handler, options);
    }) as Window["addEventListener"],
    removeEventListener: ((type: string, listener: Listener | null, options?: boolean | EventListenerOptions) => {
      if (!listener) return;
      const handler = wrapped.get(type)?.get(listener);
      if (!handler) return;
      getWindow().removeEventListener(actualType(type), handler, options);
      wrapped.get(type)?.delete(listener);
    }) as Window["removeEventListener"],
    dispatchEvent(event) {
      if (isPrivate(event.type)) {
        if (!lease?.active) return false;
        return getWindow().dispatchEvent(new Event(actualType(event.type)));
      }
      return getWindow().dispatchEvent(event);
    },
  };
}
