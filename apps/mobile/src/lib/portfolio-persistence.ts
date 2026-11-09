export type GuardedPortfolioSave = 'saved' | 'unverified' | 'conflict';

/**
 * Compare bytes before writing and pause the queue after any uncertain result.
 * Storage does not provide atomic compare-and-swap across app runtimes.
 */
export function createGuardedPortfolioWriter(
  read: () => Promise<string | null>,
  writeAndVerify: (snapshot: string) => Promise<void>,
) {
  let confirmed: string | null = null;
  let attempted: string | null = null;
  let blocked: Exclude<GuardedPortfolioSave, 'saved'> | null = null;

  function reset(snapshot: string | null) {
    confirmed = snapshot;
    attempted = null;
    blocked = null;
  }

  async function save(snapshot: string, retry = false): Promise<GuardedPortfolioSave> {
    if (blocked && !retry) return blocked;
    try {
      const stored = await read();
      if (stored === snapshot) {
        reset(snapshot);
        return 'saved';
      }
      if (stored !== confirmed && !(retry && attempted !== null && stored === attempted)) {
        blocked = 'conflict';
        return blocked;
      }
      // A previous uncertain write has now been observed exactly; it is the
      // new baseline for a later retry if this next write cannot be verified.
      confirmed = stored;
      attempted = snapshot;
      await writeAndVerify(snapshot);
      reset(snapshot);
      return 'saved';
    } catch {
      blocked = 'unverified';
      return blocked;
    }
  }

  return { reset, save: (snapshot: string) => save(snapshot), retry: (snapshot: string) => save(snapshot, true) };
}
