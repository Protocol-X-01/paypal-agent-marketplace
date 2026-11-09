import { Platform } from 'react-native';
import { fetch as expoFetch } from 'expo/fetch';
import * as WebBrowser from 'expo-web-browser';
import { createCustomerSessionClient } from './customer-session-client';
import { createCustomerSessionStorage } from './customer-session-storage';
import { customerSessionSecureAdapter } from './customer-session-secure-native';
import { isCanonicalCustomerHandle, parseCustomerSessionReturnUrl, validateCustomerAuthorizationUrl, validateCustomerSessionLinkConfig, type CustomerSessionLinkConfig, type NativePlatform } from './customer-session-links';
export { customerSessionSecureAdapter, readNativeCustomerSessionPresence } from './customer-session-secure-native';

function unavailable(): never { throw new Error('Native sign-in is unavailable.'); }
function nativePlatform(): NativePlatform { if (Platform.OS !== 'android' && Platform.OS !== 'ios') return unavailable(); return Platform.OS; }
export type CustomerNativeBrowserResult = { type: 'success'; url: string } | { type: 'cancel' | 'dismiss' };
/** Pure capability check; configuration alone cannot make legacy iOS support HTTPS auth returns. */
export function supportsCustomerAuthBrowser(platform: string, version: unknown): boolean {
  if (platform === 'android') return true;
  if (platform !== 'ios' || typeof version !== 'string' || !/^\d{1,3}(?:\.\d{1,3}){0,2}$/.test(version)) return false;
  const [major, minor = 0] = version.split('.').map(Number);
  return major > 17 || (major === 17 && minor >= 4);
}
let browserBusy = false;
let dismissActive: (() => void) | undefined;
/** Construction does not enable login or verify deployed app-link association.
 * The caller must persist/read back pending handoff BEFORE invoking openBrowser.
 */
export function createNativeCustomerSessionAdapters(config: CustomerSessionLinkConfig) {
  const checked = validateCustomerSessionLinkConfig(config), platform = nativePlatform();
  let ownedDismiss: (() => void) | undefined;
  return {
    platform,
    canStartSignIn: () => supportsCustomerAuthBrowser(Platform.OS, Platform.Version),
    client: createCustomerSessionClient(checked, { fetch: expoFetch as typeof fetch }),
    storage: createCustomerSessionStorage(customerSessionSecureAdapter, checked),
    dismissBrowser(): void { if (ownedDismiss && dismissActive === ownedDismiss) ownedDismiss(); },
    async openBrowser(input: { authorizationUrl: string; handoff: string; state: string }): Promise<CustomerNativeBrowserResult> {
      try {
        if (!input || Object.keys(input).sort().join(',') !== 'authorizationUrl,handoff,state' || !isCanonicalCustomerHandle(input.state)) unavailable();
        const url = validateCustomerAuthorizationUrl(input.authorizationUrl, input.handoff, checked);
        if (nativePlatform() !== platform || browserBusy) unavailable();
        // Expo otherwise falls back to a legacy callback scheme on older iOS.
        if (!supportsCustomerAuthBrowser(Platform.OS, Platform.Version)) unavailable();
        const returnUrl = platform === 'ios' ? checked.iosReturnUrl : checked.androidReturnUrl;
        browserBusy = true;
        let dismiss!: () => void;
        const cancelled = new Promise<CustomerNativeBrowserResult>(resolve => { dismiss = () => resolve({ type: 'dismiss' }); });
        const ownDismiss = () => {
          dismiss();
          // Expo cannot programmatically close Android Custom Tabs. Cancellation
          // still unblocks cleanup; retain the global busy lease until Expo ends.
          if (platform === 'ios') { try { WebBrowser.dismissAuthSession(); } catch { /* best effort */ } }
        };
        dismissActive = ownDismiss; ownedDismiss = ownDismiss;
        try {
          const nativeResult = Promise.resolve(WebBrowser.openAuthSessionAsync(url, returnUrl, platform === 'ios' ? { preferUniversalLinks: true } : {}));
          const release = () => { browserBusy = false; if (dismissActive === ownDismiss) dismissActive = undefined; };
          void nativeResult.then(release, release);
          const result = await Promise.race([nativeResult, cancelled]);
          if (result.type === 'cancel' || result.type === 'dismiss') return { type: result.type };
          if (result.type !== 'success') unavailable();
          parseCustomerSessionReturnUrl(result.url, platform, input.state, checked);
          return { type: 'success', url: result.url };
        } catch { if (dismissActive === ownDismiss) { browserBusy = false; dismissActive = undefined; } return unavailable(); }
      } catch { return unavailable(); }
    },
  };
}
