import { NextResponse, type NextRequest } from 'next/server';
import { handleMobileWebPreflight, isAllowedApplicationOrigin, withMobileWebCors } from '@/lib/mobile-web-cors';
import { getTrustedClientAddress, takeClientRequestLimit } from '@/lib/request-limits';
import {
  getIntradayCandles, IntradayError, isIntradayCoin, isIntradayInterval,
  type IntradayDays,
} from '@/lib/binance-intraday';

export async function GET(request: NextRequest, { params }: { params: Promise<{ coinId: string }> }) {
  const json = (body: unknown, init?: ResponseInit) => withMobileWebCors(request, NextResponse.json(body, init));
  const invalid = (code: string, message: string, status = 400, headers: Record<string, string> = {}) =>
    json({ error: { code, message } }, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
  if (!isAllowedApplicationOrigin(request)) return invalid('origin_not_allowed', 'Request origin is not allowed.', 403);
  const { coinId } = await params;
  if (!isIntradayCoin(coinId)) return invalid('unsupported_coin', 'Intraday history is unavailable for this asset.');
  const query = new URL(request.url).searchParams;
  if ([...query.keys()].some((key) => !['interval', 'days'].includes(key)) ||
      query.getAll('interval').length !== 1 || query.getAll('days').length !== 1) {
    return invalid('unsupported_parameters', 'Provide interval and days exactly once each.');
  }
  const interval = query.get('interval') ?? '';
  if (!isIntradayInterval(interval)) return invalid('unsupported_interval', 'Choose a supported candle interval.');
  const rawDays = query.get('days');
  if (rawDays !== '1' && rawDays !== '7') return invalid('unsupported_days', 'Choose a supported history range.');
  const days = Number(rawDays) as IntradayDays;
  if (days === 7 && interval !== '15m') return invalid('unsupported_window', 'Seven days requires 15-minute candles.');
  const address = getTrustedClientAddress(request);
  const clientBudget = takeClientRequestLimit(request, 'binance-intraday', 6);
  if (!clientBudget.allowed) {
    return invalid('intraday_rate_limited', 'Intraday market data is temporarily rate limited.', 429,
      { 'Retry-After': String(clientBudget.retryAfterSeconds) });
  }
  try {
    return json(await getIntradayCandles(coinId, interval, days, address), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof IntradayError && error.kind === 'rate_limited') {
      return invalid('intraday_rate_limited', 'Intraday market data is temporarily rate limited.', 429,
        { 'Retry-After': String(error.retryAfterSeconds) });
    }
    if (error instanceof IntradayError && error.kind === 'invalid_response') {
      return invalid('intraday_invalid_response', 'The market data provider returned an unexpected response.', 502);
    }
    if (error instanceof IntradayError && error.kind === 'data_gap') {
      return invalid('intraday_data_gap', 'Complete intraday history is unavailable for this window.', 503);
    }
    return invalid('intraday_unavailable', 'Intraday market data is temporarily unavailable.', 503);
  }
}

export function OPTIONS(request: NextRequest) {
  return handleMobileWebPreflight(request, ['GET']);
}
