import { validateVenmoDraftAmount } from '@/lib/venmo-draft-amount';

const INTENT_LIFETIME_MS = 5 * 60 * 1000;

type PendingIntent = {
  id: string;
  amount: string;
  createdAt: number;
  timer: ReturnType<typeof setTimeout>;
};

let sequence = 0;
let pendingIntent: PendingIntent | null = null;

/** Keep the amount in memory while routing to the existing local Venmo draft. */
export function createVenmoSendIntent(amount: string): string | null {
  if (validateVenmoDraftAmount(amount).kind !== 'valid') return null;
  if (pendingIntent && Date.now() - pendingIntent.createdAt <= INTENT_LIFETIME_MS) return null;
  if (pendingIntent) clearTimeout(pendingIntent.timer);

  sequence += 1;
  const id = `${Date.now().toString(36)}-${sequence.toString(36)}`;
  const createdAt = Date.now();
  const timer = setTimeout(() => {
    if (pendingIntent?.id === id) pendingIntent = null;
  }, INTENT_LIFETIME_MS);
  pendingIntent = { id, amount, createdAt, timer };
  return id;
}

/** Consume once. The route token is only a short-lived correlation ID, never payment data. */
export function consumeVenmoSendIntent(id: string): string | null {
  if (!pendingIntent) return null;
  if (Date.now() - pendingIntent.createdAt > INTENT_LIFETIME_MS) {
    clearTimeout(pendingIntent.timer);
    pendingIntent = null;
    return null;
  }
  if (pendingIntent.id !== id) return null;

  const amount = pendingIntent.amount;
  clearTimeout(pendingIntent.timer);
  pendingIntent = null;
  return validateVenmoDraftAmount(amount).kind === 'valid' ? amount : null;
}

export function discardVenmoSendIntent(id: string): void {
  if (pendingIntent?.id === id) {
    clearTimeout(pendingIntent.timer);
    pendingIntent = null;
  }
}
