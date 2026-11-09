export interface CandleViewport { start: number; end: number }
export type CandleViewportAction = 'in' | 'out' | 'earlier' | 'later' | 'reset';

/** Limit the number of native SVG nodes without combining or inventing candles. */
export const MAX_VISIBLE_CANDLES = 240;

export function initialCandleViewport(total: number): CandleViewport {
  const count = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
  return { start: Math.max(0, count - MAX_VISIBLE_CANDLES), end: count };
}

function normalize(viewport: CandleViewport, total: number): CandleViewport {
  const count = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
  if (count === 0) return { start: 0, end: 0 };
  const width = Math.max(1, Math.min(count, MAX_VISIBLE_CANDLES, Math.floor(viewport.end - viewport.start) || count));
  const start = Math.max(0, Math.min(count - width, Math.floor(viewport.start) || 0));
  return { start, end: start + width };
}

export function changeCandleViewport(viewport: CandleViewport, total: number, action: CandleViewportAction): CandleViewport {
  const count = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
  if (action === 'reset' || count === 0) return initialCandleViewport(count);
  const current = normalize(viewport, count);
  const width = current.end - current.start;
  const maximum = Math.min(count, MAX_VISIBLE_CANDLES);
  const minimum = Math.min(count, 4);
  if (action === 'in' || action === 'out') {
    const nextWidth = action === 'in' ? Math.max(minimum, Math.ceil(width / 2)) : Math.min(maximum, width * 2);
    const requestedStart = action === 'in' ? current.end - nextWidth : Math.floor((current.start + current.end - nextWidth) / 2);
    const start = Math.max(0, Math.min(count - nextWidth, requestedStart));
    return { start, end: start + nextWidth };
  }
  const shift = Math.max(1, Math.floor(width / 2)) * (action === 'earlier' ? -1 : 1);
  const start = Math.max(0, Math.min(count - width, current.start + shift));
  return { start, end: start + width };
}

/** Keep a selected candle visible when keyboard or assistive controls step past an edge. */
export function revealCandle(viewport: CandleViewport, total: number, index: number): CandleViewport {
  const current = normalize(viewport, total);
  if (current.end === current.start) return current;
  const selected = Math.max(0, Math.min(total - 1, Math.floor(index)));
  const width = current.end - current.start;
  if (selected < current.start) return { start: selected, end: selected + width };
  if (selected >= current.end) return { start: selected - width + 1, end: selected + 1 };
  return current;
}
