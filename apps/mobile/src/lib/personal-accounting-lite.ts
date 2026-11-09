import { businessCurrencyMinorDigits } from './business-snapshot';

export type MoneyInput = { kind: 'empty' | 'incomplete' | 'invalid' } | { kind: 'valid'; minor: bigint };
const ZERO = BigInt(0);
const TEN = BigInt(10);
const MAX_MAJOR = BigInt('1000000000000');

function scaleFor(currency: string): { digits: number; scale: bigint } | null {
  const digits = businessCurrencyMinorDigits(currency);
  if (digits === null) return null;
  let scale = BigInt(1);
  for (let index = 0; index < digits; index += 1) scale *= TEN;
  return { digits, scale };
}

export function liteCurrencyDigits(currency: string): number | null {
  return scaleFor(currency)?.digits ?? null;
}

/** Parse non-negative decimal text into exact ISO minor units. */
export function parseLiteMoney(raw: string, currency: string): MoneyInput {
  const units = scaleFor(currency);
  if (!units || raw.length > 32) return { kind: 'invalid' };
  const text = raw.trim();
  if (!text) return { kind: 'empty' };
  if (units.digits > 0 && (/^\d+\.$/.test(text) || text === '.')) return { kind: 'incomplete' };
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(text)) return { kind: 'invalid' };
  const [whole, fraction = ''] = text.split('.');
  if (fraction.length > units.digits) return { kind: 'invalid' };
  const minor = BigInt(whole || '0') * units.scale + BigInt((fraction + '0'.repeat(units.digits)).slice(0, units.digits) || '0');
  return minor > MAX_MAJOR * units.scale ? { kind: 'invalid' } : { kind: 'valid', minor };
}

/** Portfolio input is an estimate; it is explicitly rounded to minor units. */
export function roundedPortfolioMinor(value: number | null, currency: string): bigint | null {
  const units = scaleFor(currency);
  if (!units || value === null || !Number.isFinite(value) || value < 0 || value > 1_000_000_000_000) return null;
  const parsed = parseLiteMoney(value.toFixed(units.digits), currency);
  return parsed.kind === 'valid' ? parsed.minor : null;
}

export function formatLiteMoney(minor: bigint, currency: string): string {
  const units = scaleFor(currency);
  if (!units) return 'Unavailable';
  const negative = minor < ZERO;
  const absolute = negative ? -minor : minor;
  const whole = (absolute / units.scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = units.digits ? `.${(absolute % units.scale).toString().padStart(units.digits, '0')}` : '';
  return `${negative ? '−' : ''}${currency} ${whole}${fraction}`;
}

export function liteClosingAmount(start: bigint, income: bigint, spending: bigint): bigint {
  return start + income - spending;
}

/** Months assume a fixed contribution and no interest or investment return. */
export function liteMonthsToTarget(start: bigint, target: bigint, monthly: bigint): bigint | null {
  if (target <= start) return ZERO;
  if (monthly <= ZERO) return null;
  const remaining = target - start;
  return (remaining + monthly - BigInt(1)) / monthly;
}
