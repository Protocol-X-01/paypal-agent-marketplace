/** Preserve recognized and future two-letter storefront provenance in saved lists. */
export function readSavedStorefront(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && /^[A-Z]{2}$/.test(value)) return value;
  throw new Error("Saved storefront provenance could not be read.");
}
