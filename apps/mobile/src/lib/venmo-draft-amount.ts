/** A local draft amount only; this does not represent Venmo's payment limits. */
export const VENMO_DRAFT_AMOUNT_MAX_LENGTH = 32;

/** Local draft limit, matching the app's saved-contact handle length. */
export const VENMO_DRAFT_HANDLE_MAX_LENGTH = 40;

/** Local length limit for draft messages, counted in JavaScript UTF-16 code units. */
export const VENMO_DRAFT_NOTE_MAX_LENGTH = 280;

export type VenmoDraftRecipient =
  | { kind: 'empty' }
  | { kind: 'invalid'; reason: 'format' | 'length' }
  | { kind: 'valid'; handle: string };

/** Allow one optional @ prefix without silently changing the entered handle. */
export function validateVenmoDraftRecipient(value: string): VenmoDraftRecipient {
  if (value === '') return { kind: 'empty' };
  const handle = value.startsWith('@') ? value.slice(1) : value;
  if (handle.length > VENMO_DRAFT_HANDLE_MAX_LENGTH) return { kind: 'invalid', reason: 'length' };
  if (!/^[A-Za-z0-9._-]+$/.test(handle)) return { kind: 'invalid', reason: 'format' };
  return { kind: 'valid', handle };
}

/** Advisory only: preserve the local draft/storage format and older contacts. */
export function venmoUsernameNeedsReview(value: string): boolean {
  const recipient = validateVenmoDraftRecipient(value);
  if (recipient.kind !== 'valid') return false;
  return recipient.handle.length < 5 || recipient.handle.length > 30 || !/^[A-Za-z0-9_-]+$/.test(recipient.handle);
}

export const VENMO_USERNAME_GUIDANCE = 'Venmo says usernames are 5–30 characters and may use hyphens or underscores, but no other special characters. Check the username in Venmo.';

export type VenmoDraftAmount =
  | { kind: 'empty' }
  | { kind: 'incomplete' }
  | { kind: 'invalid'; reason: 'format' | 'precision' | 'length' | 'zero' }
  | { kind: 'valid'; formatted: string };

/** Parse without modifying or rounding the customer's entered text. */
export function validateVenmoDraftAmount(value: string): VenmoDraftAmount {
  if (value === '') return { kind: 'empty' };
  if (value.length > VENMO_DRAFT_AMOUNT_MAX_LENGTH) return { kind: 'invalid', reason: 'length' };
  if (!/^(?:\d+(?:[.,]\d*)?|[.,]\d*)$/.test(value)) return { kind: 'invalid', reason: 'format' };
  if (value.endsWith('.') || value.endsWith(',')) return { kind: 'incomplete' };
  const [integerPart = '', fractionalPart = ''] = value.split(/[.,]/);
  if (fractionalPart.length > 2) return { kind: 'invalid', reason: 'precision' };
  const whole = (integerPart || '0').replace(/^0+(?=\d)/, '');
  const cents = fractionalPart.padEnd(2, '0');
  if (whole === '0' && cents === '00') return { kind: 'invalid', reason: 'zero' };
  return { kind: 'valid', formatted: `$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${cents}` };
}

export type PreparedVenmoDraft =
  | { ok: true; text: string; amount: VenmoDraftAmount; recipient: VenmoDraftRecipient; noteTooLong: boolean }
  | { ok: false; reason: 'empty' | 'amount' | 'recipient' | 'note'; amount: VenmoDraftAmount; recipient: VenmoDraftRecipient; noteTooLong: boolean };

/** Build copyable text only when entered amounts and handles can be interpreted safely. */
export function prepareVenmoDraft(rawRecipient: string, note: string, rawAmount: string): PreparedVenmoDraft {
  const amount = validateVenmoDraftAmount(rawAmount);
  const recipient = validateVenmoDraftRecipient(rawRecipient);
  const noteTooLong = note.length > VENMO_DRAFT_NOTE_MAX_LENGTH;
  if (recipient.kind === 'invalid') return { ok: false, reason: 'recipient', amount, recipient, noteTooLong };
  if (amount.kind === 'incomplete' || amount.kind === 'invalid') return { ok: false, reason: 'amount', amount, recipient, noteTooLong };
  if (noteTooLong) return { ok: false, reason: 'note', amount, recipient, noteTooLong };
  const message = note.trim() ? note : '';
  if (recipient.kind === 'empty' && !message && amount.kind === 'empty') return { ok: false, reason: 'empty', amount, recipient, noteTooLong };
  const text = [
    'Venmo message draft — review and send yourself',
    recipient.kind === 'valid' ? `To: @${recipient.handle}` : null,
    amount.kind === 'valid' ? `Amount: ${amount.formatted}` : null,
    message ? `Note: ${message}` : null,
  ].filter(Boolean).join('\n');
  return { ok: true, text, amount, recipient, noteTooLong };
}
