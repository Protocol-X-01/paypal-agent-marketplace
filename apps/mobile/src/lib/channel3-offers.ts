export const VERIFIED_OFFERS_TTL_MS = 5 * 60 * 1_000;

/** A device clock change must not extend the lifetime of a retailer link. */
export function isFreshVerifiedOffer(verifiedAt: number, now: number): boolean {
  const age = now - verifiedAt;
  return Number.isFinite(age) && age >= 0 && age < VERIFIED_OFFERS_TTL_MS;
}
