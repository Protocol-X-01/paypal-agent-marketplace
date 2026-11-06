/** Fiat currencies offered for market and portfolio display. */
export const MARKET_CURRENCIES = [
  "USD", "GBP", "EUR", "AED", "AUD", "BRL", "CAD", "CHF", "CNY",
  "CZK", "DKK", "HKD", "HUF", "ILS", "INR", "JPY", "MXN", "MYR",
  "NOK", "NZD", "PHP", "PLN", "SEK", "SGD", "THB", "TWD", "ZAR",
] as const;

export type MarketCurrency = (typeof MARKET_CURRENCIES)[number];

export const MARKET_CURRENCY_LABELS: Record<MarketCurrency, string> = {
  USD: "US dollar",
  GBP: "British pound",
  EUR: "Euro",
  AED: "UAE dirham",
  AUD: "Australian dollar",
  BRL: "Brazilian real",
  CAD: "Canadian dollar",
  CHF: "Swiss franc",
  CNY: "Chinese yuan",
  CZK: "Czech koruna",
  DKK: "Danish krone",
  HKD: "Hong Kong dollar",
  HUF: "Hungarian forint",
  ILS: "Israeli new shekel",
  INR: "Indian rupee",
  JPY: "Japanese yen",
  MXN: "Mexican peso",
  MYR: "Malaysian ringgit",
  NOK: "Norwegian krone",
  NZD: "New Zealand dollar",
  PHP: "Philippine peso",
  PLN: "Polish zloty",
  SEK: "Swedish krona",
  SGD: "Singapore dollar",
  THB: "Thai baht",
  TWD: "New Taiwan dollar",
  ZAR: "South African rand",
};

const supportedCurrencies: ReadonlySet<string> = new Set(MARKET_CURRENCIES);

export function isMarketCurrency(value: unknown): value is MarketCurrency {
  return typeof value === "string" && supportedCurrencies.has(value);
}
