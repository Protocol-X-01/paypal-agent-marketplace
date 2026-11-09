import { validateCustomerSessionLinkConfig, type CustomerSessionLinkConfig } from './customer-session-links';

export type CustomerSessionConfiguration =
  | Readonly<{ status: 'disabled' }>
  | Readonly<{ status: 'invalid' }>
  | Readonly<{ status: 'ready'; links: CustomerSessionLinkConfig }>;

/** Public build configuration, never credentials. A ready result does not prove
 * server readiness or platform/domain association. Never borrow the market URL:
 * development markets may use HTTP while sign-in must use its explicit origin.
 * Disabled/invalid configuration does not authorize guest hydration over an
 * existing secure session; runtime must check secure-record presence first. */
export function readCustomerSessionConfiguration(env: Readonly<Record<string, string | undefined>>): CustomerSessionConfiguration {
  const enabled = env.EXPO_PUBLIC_CUSTOMER_LOGIN_ENABLED;
  if (enabled === undefined || enabled === '' || enabled === 'false') return Object.freeze({ status: 'disabled' });
  if (enabled !== 'true' || env.EXPO_PUBLIC_CUSTOMER_LINKS_VERIFIED !== 'true') return Object.freeze({ status: 'invalid' });
  try {
    const links = validateCustomerSessionLinkConfig({
      origin: env.EXPO_PUBLIC_CUSTOMER_AUTH_ORIGIN ?? '',
      androidReturnUrl: env.EXPO_PUBLIC_CUSTOMER_ANDROID_RETURN_URL ?? '',
      iosReturnUrl: env.EXPO_PUBLIC_CUSTOMER_IOS_RETURN_URL ?? '',
    });
    return Object.freeze({ status: 'ready', links });
  } catch {
    return Object.freeze({ status: 'invalid' });
  }
}
