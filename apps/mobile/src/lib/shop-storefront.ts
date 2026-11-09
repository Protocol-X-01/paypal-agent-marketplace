import AsyncStorage from '@react-native-async-storage/async-storage';

export type ShopStorefront = 'GB' | 'US';
export type ShopDiscoveryMode = 'browse' | 'search';
export type StorefrontTicket = { storefront: ShopStorefront; revision: number };
export const DEFAULT_SHOP_STOREFRONT: ShopStorefront = 'US';
export const SHOP_STOREFRONT_KEY = 'paypal-markets.mobile.shop-storefront.v1';
export const SHOP_DISCOVERY_MODE_KEY = 'paypal-markets.mobile.shop-discovery-mode.v1';

export const SHOP_STOREFRONTS: Record<ShopStorefront, { label: string; shortLabel: string; currency: 'GBP' | 'USD' }> = {
  GB: { label: 'United Kingdom', shortLabel: 'UK', currency: 'GBP' },
  US: { label: 'United States', shortLabel: 'US', currency: 'USD' },
};

export function isShopStorefront(value: unknown): value is ShopStorefront {
  return value === 'GB' || value === 'US';
}

export function isShopDiscoveryMode(value: unknown): value is ShopDiscoveryMode {
  return value === 'browse' || value === 'search';
}

export async function loadShopDiscoveryMode(): Promise<ShopDiscoveryMode> {
  const value = await AsyncStorage.getItem(SHOP_DISCOVERY_MODE_KEY);
  return isShopDiscoveryMode(value) ? value : 'browse';
}

export async function saveShopDiscoveryMode(mode: ShopDiscoveryMode): Promise<void> {
  if (!isShopDiscoveryMode(mode)) throw new Error('Choose Browse or Search.');
  await AsyncStorage.setItem(SHOP_DISCOVERY_MODE_KEY, mode);
  if (await AsyncStorage.getItem(SHOP_DISCOVERY_MODE_KEY) !== mode) throw new Error('Shop view could not be verified.');
}

export async function loadShopStorefront(): Promise<{ storefront: ShopStorefront; status: 'default' | 'saved' | 'invalid' }> {
  const value = await AsyncStorage.getItem(SHOP_STOREFRONT_KEY);
  if (value === null) return { storefront: DEFAULT_SHOP_STOREFRONT, status: 'default' };
  if (!isShopStorefront(value)) return { storefront: DEFAULT_SHOP_STOREFRONT, status: 'invalid' };
  return { storefront: value, status: 'saved' };
}

export async function saveShopStorefront(storefront: ShopStorefront): Promise<void> {
  if (!isShopStorefront(storefront)) throw new Error('Choose a supported shop region.');
  await AsyncStorage.setItem(SHOP_STOREFRONT_KEY, storefront);
  if (await AsyncStorage.getItem(SHOP_STOREFRONT_KEY) !== storefront) throw new Error('Shop region could not be verified.');
}

/** A revision also invalidates old UK work after a UK -> US -> UK switch. */
export function createStorefrontFence(initial: ShopStorefront) {
  let storefront = initial;
  let revision = 0;
  return {
    current: () => storefront,
    capture: (): StorefrontTicket => ({ storefront, revision }),
    select(next: ShopStorefront): boolean {
      if (next === storefront) return false;
      storefront = next;
      revision += 1;
      return true;
    },
    isCurrent(ticket: StorefrontTicket): boolean {
      return ticket.storefront === storefront && ticket.revision === revision;
    },
  };
}
