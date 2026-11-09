import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { readCustomerSessionConfiguration } from './customer-session-config';
import { createCustomerSessionRuntime, type CustomerLoginStatus } from './customer-session-runtime';
import { createCustomerStorageFence } from './customer-storage-scope';
import type { ValidatedNativeSession } from './customer-session-client';

export type CustomerSessionContextValue = Readonly<{
  status: 'holding' | 'guest' | 'authenticated'; identity: Readonly<ValidatedNativeSession> | null;
  revision: number; storageFence: ReturnType<typeof createCustomerStorageFence>;
  loginStatus: CustomerLoginStatus; loginAvailable: boolean;
  start(): Promise<void>; logout(): Promise<void>; retry(): Promise<void>;
}>;
const Context = createContext<CustomerSessionContextValue | null>(null);
const noop = async () => {};
export function CustomerSessionProvider({ children }: React.PropsWithChildren) {
  const [fence] = useState(() => createCustomerStorageFence());
  const [value, setValue] = useState<CustomerSessionContextValue>(() => ({ status: 'holding', identity: null, revision: 0, storageFence: fence, loginStatus: 'checking', loginAvailable: false, start: noop, logout: noop, retry: noop }));
  useEffect(() => {
    const configuration = readCustomerSessionConfiguration({
      EXPO_PUBLIC_CUSTOMER_LOGIN_ENABLED: process.env.EXPO_PUBLIC_CUSTOMER_LOGIN_ENABLED,
      EXPO_PUBLIC_CUSTOMER_LINKS_VERIFIED: process.env.EXPO_PUBLIC_CUSTOMER_LINKS_VERIFIED,
      EXPO_PUBLIC_CUSTOMER_AUTH_ORIGIN: process.env.EXPO_PUBLIC_CUSTOMER_AUTH_ORIGIN,
      EXPO_PUBLIC_CUSTOMER_ANDROID_RETURN_URL: process.env.EXPO_PUBLIC_CUSTOMER_ANDROID_RETURN_URL,
      EXPO_PUBLIC_CUSTOMER_IOS_RETURN_URL: process.env.EXPO_PUBLIC_CUSTOMER_IOS_RETURN_URL,
    });
    const runtime = createCustomerSessionRuntime({ platform: Platform.OS, configuration, foreground: AppState.currentState === 'active', fence,
      presence: async () => (await import('./customer-session-secure-native')).readNativeCustomerSessionPresence(),
      loadNative: async config => {
        const [{ createNativeCustomerSessionAdapters }, { createCustomerSignInSecrets }] = await Promise.all([import('./customer-session-native'), import('./customer-session-crypto')]);
        return { ...createNativeCustomerSessionAdapters(config), secrets: createCustomerSignInSecrets };
      },
    });
    let lastPrivateRevision = -1;
    const unsubscribe = runtime.subscribe(next => { const changed = lastPrivateRevision !== next.revision; lastPrivateRevision = next.revision; setValue(previous => ({ status: next.session.status, identity: next.session.status === 'authenticated' ? next.session.identity : null, revision: previous.revision + (changed ? 1 : 0), storageFence: fence, loginStatus: next.loginStatus, loginAvailable: next.loginStatus === 'available', start: runtime.start, logout: runtime.logout, retry: runtime.retry })); });
    const change = AppState.addEventListener('change', next => { void runtime.setForeground(next === 'active'); });
    // Android notification shade does not change AppState; blur still hides data.
    const blur = Platform.OS === 'android' ? AppState.addEventListener('blur', () => { void runtime.setForeground(false); }) : undefined;
    const focus = Platform.OS === 'android' ? AppState.addEventListener('focus', () => { void runtime.setForeground(AppState.currentState === 'active'); }) : undefined;
    void runtime.initialize();
    return () => { unsubscribe(); change.remove(); blur?.remove(); focus?.remove(); runtime.dispose(); };
  }, [fence]);
  const stable = useMemo(() => value, [value]);
  return <Context.Provider value={stable}>{children}</Context.Provider>;
}
export function useCustomerSession(): CustomerSessionContextValue {
  const value = useContext(Context);
  if (!value) throw new Error('Customer session provider is unavailable.');
  return value;
}
