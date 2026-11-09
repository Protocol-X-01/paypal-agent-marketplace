export type AllocationValue = { id: string; value: number | null };
export type AllocationSlice<T extends AllocationValue> = T & { value: number; share: number; start: number };

/** Only complete, positive totals can be represented as a 100% allocation. */
export function portfolioAllocation<T extends AllocationValue>(positions: readonly T[], total: number | null): AllocationSlice<T>[] | null {
  if (!positions.length || total === null || !Number.isFinite(total) || total <= 0) return null;
  if (positions.some((position) => position.value === null || !Number.isFinite(position.value) || position.value < 0)) return null;
  const sum = positions.reduce((result, position) => result + position.value!, 0);
  if (!Number.isFinite(sum) || sum <= 0 || Math.abs(sum - total) > Math.max(sum, total) * 1e-12) return null;
  let start = 0;
  return positions.map((position) => {
    const value = position.value!;
    const share = value / sum * 100;
    const slice = { ...position, value, share, start };
    start += share;
    return slice;
  });
}

export function allocationShareLabel(share: number): string {
  if (share > 0 && share < 0.1) return "Less than 0.1%";
  if (share < 100 && share > 99.9) return "More than 99.9%";
  return `${share.toFixed(1)}%`;
}
