import { isIP } from 'node:net';

const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 8;
const MAX_RATE_ENTRIES = 2_000;

type RateEntry = { startedAt: number; count: number };

const globalForChannel3 = globalThis as typeof globalThis & {
  __channel3Rate?: Map<string, RateEntry>;
};
const rate = (globalForChannel3.__channel3Rate ??= new Map());

function clientAddress(request: Request): string {
  // Render's Cloudflare edge overwrites this header. X-Forwarded-For can
  // preserve caller-supplied entries, so it is not safe as a limiter key here.
  const candidate = request.headers.get('cf-connecting-ip')?.trim();
  return candidate && isIP(candidate) ? candidate : 'unknown';
}

export function takeChannel3RateLimit(request: Request, now = Date.now()): boolean {
  const address = clientAddress(request);
  const current = rate.get(address);
  if (current && now - current.startedAt < WINDOW_MS) {
    if (current.count >= MAX_REQUESTS_PER_WINDOW) return false;
    current.count += 1;
    return true;
  }

  if (rate.size >= MAX_RATE_ENTRIES) {
    for (const [key, entry] of rate) {
      if (now - entry.startedAt >= WINDOW_MS) rate.delete(key);
    }
  }
  if (rate.size >= MAX_RATE_ENTRIES) return false;

  rate.set(address, { startedAt: now, count: 1 });
  return true;
}
