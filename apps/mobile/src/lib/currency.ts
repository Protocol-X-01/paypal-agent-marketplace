export const DISPLAY_CURRENCIES = [
  { code: 'USD', name: 'US dollar' },
  { code: 'GBP', name: 'British pound' },
  { code: 'EUR', name: 'Euro' },
  { code: 'AED', name: 'UAE dirham' },
  { code: 'AUD', name: 'Australian dollar' },
  { code: 'BRL', name: 'Brazilian real' },
  { code: 'CAD', name: 'Canadian dollar' },
  { code: 'CHF', name: 'Swiss franc' },
  { code: 'CNY', name: 'Chinese yuan' },
  { code: 'CZK', name: 'Czech koruna' },
  { code: 'DKK', name: 'Danish krone' },
  { code: 'HKD', name: 'Hong Kong dollar' },
  { code: 'HUF', name: 'Hungarian forint' },
  { code: 'ILS', name: 'Israeli new shekel' },
  { code: 'INR', name: 'Indian rupee' },
  { code: 'JPY', name: 'Japanese yen' },
  { code: 'MXN', name: 'Mexican peso' },
  { code: 'MYR', name: 'Malaysian ringgit' },
  { code: 'NOK', name: 'Norwegian krone' },
  { code: 'NZD', name: 'New Zealand dollar' },
  { code: 'PHP', name: 'Philippine peso' },
  { code: 'PLN', name: 'Polish zloty' },
  { code: 'SEK', name: 'Swedish krona' },
  { code: 'SGD', name: 'Singapore dollar' },
  { code: 'THB', name: 'Thai baht' },
  { code: 'TWD', name: 'New Taiwan dollar' },
  { code: 'ZAR', name: 'South African rand' },
] as const;

export type DisplayCurrency = (typeof DISPLAY_CURRENCIES)[number]['code'];
export const DEFAULT_DISPLAY_CURRENCY: DisplayCurrency = 'USD';

export function isDisplayCurrency(value: unknown): value is DisplayCurrency {
  return typeof value === 'string' && DISPLAY_CURRENCIES.some((item) => item.code === value);
}

export function filterDisplayCurrencies(query: string) {
  const search = query.trim().toLowerCase();
  return DISPLAY_CURRENCIES.filter((item) =>
    item.code.toLowerCase().includes(search) || item.name.toLowerCase().includes(search));
}

export function formatCurrency(value: number | null | undefined, currency: DisplayCurrency = DEFAULT_DISPLAY_CURRENCY, compact = false, minimumFractionDigits?: number): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const safeCurrency = isDisplayCurrency(currency) ? currency : DEFAULT_DISPLAY_CURRENCY;
  const notation = compact ? 'compact' : 'standard';
  const standard = new Intl.NumberFormat('en-US', { style: 'currency', currency: safeCurrency, notation }).resolvedOptions();
  const minimum = Math.max(standard.minimumFractionDigits ?? 2, minimumFractionDigits ?? 0);
  const standardMaximum = standard.maximumFractionDigits ?? 2;
  const maximumFractionDigits = Math.max(minimum, compact ? Math.max(2, standardMaximum) : Math.abs(value) < 1 ? Math.max(8, standardMaximum) : minimumFractionDigits ? Math.max(minimum + 2, standardMaximum) : standardMaximum);
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: safeCurrency,
    notation,
    minimumFractionDigits: minimum,
    maximumFractionDigits,
  }).format(value);
}
