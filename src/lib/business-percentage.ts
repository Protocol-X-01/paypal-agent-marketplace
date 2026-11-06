/** Keep small nonzero report values distinct from a true zero. */
export function formatBusinessPercentage(value: number | null, signed = false): string {
  if (value === null || !Number.isFinite(value)) return "Unavailable";
  if (value !== 0 && Math.abs(value) < 0.05) {
    if (signed || value < 0) return `${value > 0 ? "Increase" : "Decrease"} under 0.1%`;
    return "Under 0.1%";
  }
  return `${signed && value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}
