import 'server-only';

import { NextResponse } from 'next/server';

const DEVELOPMENT_WEB_ORIGINS = new Set([
  'http://localhost:8081',
  'http://127.0.0.1:8081',
]);
const ALLOWED_REQUEST_HEADERS = new Set(['accept', 'content-type']);
const PREFLIGHT_VARY = 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers';

function configuredWebOrigins(): Set<string> {
  const configured = (process.env.MOBILE_WEB_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  const valid = new Set<string>();
  for (const origin of configured) {
    try {
      const parsed = new URL(origin);
      if (
        parsed.origin !== origin ||
        parsed.username !== '' ||
        parsed.password !== '' ||
        (process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:')
      ) continue;
      valid.add(origin);
    } catch {
      // Invalid entries are ignored; origins must be exact scheme + host pairs.
    }
  }
  return valid;
}

function allowedMobileWebOrigin(origin: string): string | null {
  if (configuredWebOrigins().has(origin)) return origin;
  if (process.env.NODE_ENV !== 'production' && DEVELOPMENT_WEB_ORIGINS.has(origin)) return origin;
  return null;
}

export function isAllowedApplicationOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  const host = request.headers.get('host');
  if (!origin || !host) return true;

  try {
    if (new URL(origin).host === host) return true;
  } catch {
    return false;
  }
  return allowedMobileWebOrigin(origin) === origin;
}

function appendVaryOrigin(response: NextResponse): void {
  const existing = response.headers.get('Vary')
    ?.split(',')
    .map((value) => value.trim())
    .filter(Boolean) ?? [];
  if (!existing.some((value) => value.toLowerCase() === 'origin')) existing.push('Origin');
  response.headers.set('Vary', existing.join(', '));
}

export function withMobileWebCors(request: Request, response: NextResponse): NextResponse {
  const origin = request.headers.get('origin');
  // Every response is a separate cache variant, including requests without an
  // Origin header. Otherwise a shared cache can reuse a response that lacks
  // the mobile-web CORS header for an allowed browser origin.
  appendVaryOrigin(response);
  if (origin && allowedMobileWebOrigin(origin) === origin) {
    response.headers.set('Access-Control-Allow-Origin', origin);
  }
  return response;
}

export function handleMobileWebPreflight(request: Request, methods: string[]): NextResponse {
  const origin = request.headers.get('origin');
  const denied = () => new NextResponse(null, { status: 403, headers: { 'Cache-Control': 'no-store', Vary: PREFLIGHT_VARY } });
  if (!origin || allowedMobileWebOrigin(origin) !== origin) return denied();

  const requestedMethod = request.headers.get('access-control-request-method')?.toUpperCase();
  if (!requestedMethod || !methods.includes(requestedMethod)) return denied();

  const requestedHeaders = (request.headers.get('access-control-request-headers') ?? '')
    .split(',')
    .map((header) => header.trim().toLowerCase())
    .filter(Boolean);
  if (requestedHeaders.some((header) => !ALLOWED_REQUEST_HEADERS.has(header))) return denied();

  const response = new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': [...methods, 'OPTIONS'].join(', '),
      'Access-Control-Allow-Headers': 'Accept, Content-Type',
      'Access-Control-Max-Age': '600',
      'Cache-Control': 'no-store',
      Vary: PREFLIGHT_VARY,
    },
  });
  return response;
}
