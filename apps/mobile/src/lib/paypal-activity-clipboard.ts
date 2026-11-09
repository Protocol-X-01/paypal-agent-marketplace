import {
  summarizePayPalActivity,
  type PayPalActivityOptions,
  type PayPalActivitySummary,
} from './paypal-activity-import';

export type ActivityClipboardChoices = {
  native: boolean;
  dateOrder: '' | PayPalActivityOptions['dateOrder'];
  timeZone: '' | PayPalActivityOptions['timeZone'];
  windowDays: 0 | 7 | 30;
  endExclusive: string;
  privacyConfirmed: boolean;
  coverageConfirmed: boolean;
};

export type ActivityClipboardResult =
  | { kind: 'success'; summary: PayPalActivitySummary }
  | { kind: 'error'; message: string }
  | { kind: 'cancelled' };

export function usableEndDate(value: string, todayUtc: string): boolean {
  if (!todayUtc || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number(value.slice(0, 4)) < 1900) return false;
  const date = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(date) && new Date(date).toISOString().slice(0, 10) === value && value <= todayUtc;
}

export function canReadActivityClipboard(choices: ActivityClipboardChoices, todayUtc: string): boolean {
  return choices.native && (choices.dateOrder === 'dmy' || choices.dateOrder === 'mdy')
    && ['utc', 'london', 'eastern', 'central', 'mountain', 'arizona', 'pacific', 'alaska', 'hawaii'].includes(choices.timeZone)
    && (choices.windowDays === 7 || choices.windowDays === 30)
    && usableEndDate(choices.endExclusive, todayUtc)
    && choices.privacyConfirmed === true && choices.coverageConfirmed === true;
}

function pastedTextError(error: string): string {
  if (error.startsWith('The file is not a supported UTF-8 CSV.')) return 'The copied text is not a supported CSV. Check the report and try again.';
  if (error.startsWith('The file is too large.')) return 'The copied text is too large. Use one CSV of at most 4 MiB.';
  if (error.startsWith('The file has no activity rows')) return error.replace('The file', 'The copied text');
  return error.replace('before selecting the file', 'before reading the copied text');
}

/** The injected reader is called only after consent; raw clipboard text is never returned. */
export async function readActivityClipboard(
  choices: ActivityClipboardChoices,
  read: () => Promise<string>,
  isCurrent: () => boolean,
  now: () => number,
): Promise<ActivityClipboardResult> {
  try {
    if (!isCurrent()) return { kind: 'cancelled' };
    const startedAt = now();
    if (!Number.isFinite(startedAt) || !canReadActivityClipboard(choices, new Date(startedAt).toISOString().slice(0, 10))) {
      return { kind: 'error', message: 'Choose the report settings and confirm permission and coverage before reading copied text.' };
    }
    const { dateOrder, timeZone, windowDays, endExclusive, coverageConfirmed } = choices;
    if (!dateOrder || !timeZone || !windowDays) return { kind: 'error', message: 'Choose the report settings before reading copied text.' };
    const text = await read();
    if (!isCurrent()) return { kind: 'cancelled' };
    if (!text) return { kind: 'error', message: 'The clipboard is empty or access was denied. Copy the complete report and try again.' };
    const result = summarizePayPalActivity(text, { dateOrder, timeZone, windowDays, endExclusive, coverageConfirmed, nowMs: now() });
    if (!isCurrent()) return { kind: 'cancelled' };
    return result.ok ? { kind: 'success', summary: result.summary } : { kind: 'error', message: pastedTextError(result.error) };
  } catch {
    return isCurrent()
      ? { kind: 'error', message: 'The copied text could not be read. Your device may not support a clipboard this large.' }
      : { kind: 'cancelled' };
  }
}
