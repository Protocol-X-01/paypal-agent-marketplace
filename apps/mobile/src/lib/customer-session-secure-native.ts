import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { CUSTOMER_SESSION_STORAGE_KEY, classifyCustomerSessionStoragePresence, type CustomerSessionSecureAdapter } from './customer-session-storage';
import type { NativePlatform } from './customer-session-links';

const KEY = CUSTOMER_SESSION_STORAGE_KEY;
const options = Object.freeze({ keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
function unavailable(): never { throw new Error('Native sign-in is unavailable.'); }
function nativePlatform(): NativePlatform {
  if (Platform.OS !== 'android' && Platform.OS !== 'ios') return unavailable();
  return Platform.OS;
}
async function ready(key: string) {
  nativePlatform();
  if (key !== KEY || !(await SecureStore.isAvailableAsync())) unavailable();
}
/** Shared identity is essential to the storage coordinator. No web fallback.
 * iOS uses device-only, when-unlocked Keychain accessibility. Android uses Expo
 * Keystore encryption; the accessibility option does not add an Android lock gate.
 * Android SecureStore backup exclusion must also be verified in the built app.
 */
export const customerSessionSecureAdapter: CustomerSessionSecureAdapter = Object.freeze({
  kind: 'native-secure-device-only' as const,
  async getItem(key: string) {
    try { await ready(key); return await SecureStore.getItemAsync(key, options); } catch { return unavailable(); }
  },
  async setItem(key: string, value: string) {
    try {
      if (typeof value !== 'string' || value.length > 1900 || /[^\x20-\x7e]/.test(value)) unavailable();
      await ready(key); await SecureStore.setItemAsync(key, value, options);
    } catch { unavailable(); }
  },
});
/** Disabled/absent configuration may expose guest mode only after proving this
 * auth key is missing or a canonical envelope contains no authentication material.
 * Corrupt/noncanonical values remain a hold; an empty envelope needs no binding match.
 */
export async function readNativeCustomerSessionPresence(): Promise<'empty' | 'present' | 'unavailable'> {
  try { return classifyCustomerSessionStoragePresence(await customerSessionSecureAdapter.getItem(KEY)); }
  catch { return 'unavailable'; }
}
