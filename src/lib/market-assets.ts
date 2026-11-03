export const TRACKED_COINS = [
  "bitcoin",
  "ethereum",
  "solana",
  "chainlink",
  "litecoin",
  "bitcoin-cash",
  "paypal-usd",
] as const;

export type TrackedCoin = (typeof TRACKED_COINS)[number];
