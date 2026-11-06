import { NextResponse, type NextRequest } from 'next/server';

import { browseCatalog, decodeCatalogPageToken, encodeCatalogPageToken, getChannel3Locale, getChannel3CollectionId } from '@/lib/channel3';
import { findChannel3CuratedSection, findChannel3CuratedRetailer } from '@/lib/channel3-catalog';
import { isStorefront } from '@/lib/channel3-storefront';
import { takeChannel3RateLimit } from '@/lib/channel3-rate-limit';
import { handleMobileWebPreflight, isAllowedApplicationOrigin, withMobileWebCors } from '@/lib/mobile-web-cors';

function json(request: NextRequest, body: unknown, init?: ResponseInit): NextResponse {
  return withMobileWebCors(request, NextResponse.json(body, init));
}

export async function GET(request: NextRequest) {
  if (!isAllowedApplicationOrigin(request)) {
    return json(request, { error: 'Request origin is not allowed.' }, { status: 403 });
  }

  const params = request.nextUrl.searchParams;
  const allowed = new Set(['section', 'retailer', 'storefront', 'limit', 'pageToken']);
  if (request.nextUrl.search.length > 8192 || [...params.keys()].some(key => !allowed.has(key) || params.getAll(key).length !== 1)) {
    return json(request, { error: 'Choose valid catalog filters.' }, { status: 400 });
  }
  const sectionId = params.get('section'), retailerId = params.get('retailer');
  const section = findChannel3CuratedSection(sectionId), retailer = findChannel3CuratedRetailer(retailerId);
  if ((!section && !retailer) || (sectionId !== null && !section) || (retailerId !== null && !retailer)) {
    return json(request, { error: 'Choose one of the curated catalog sections or retailers.' }, { status: 400 });
  }
  const storefront = params.get('storefront');
  if (storefront !== null && !isStorefront(storefront)) return json(request, { error: 'Choose the GB or US storefront.' }, { status: 400 });
  const rawLimit = params.get('limit');
  if (rawLimit !== null && rawLimit !== '12' && rawLimit !== '24') return json(request, { error: 'Choose 12 or 24 products per request.' }, { status: 400 });
  const limit = rawLimit === '12' ? 12 : 24;
  const cursor = params.get('pageToken');
  if (cursor !== null && (!cursor || cursor.length > 6144)) return json(request, { error: 'Restart this catalog selection to load more products.' }, { status: 400 });

  if (!takeChannel3RateLimit(request)) {
    return json(
      request,
      { error: 'The curated catalog is temporarily limited. Please wait a minute and try again.' },
      { status: 429, headers: { 'Retry-After': '60', 'Cache-Control': 'no-store' } },
    );
  }

  try {
    const locale = getChannel3Locale(isStorefront(storefront) ? storefront : undefined);
    const binding = JSON.stringify({ section: section?.id ?? null, categoryId: section?.categoryId ?? null, retailer: retailer?.id ?? null, websiteId: retailer?.websiteId ?? null, collectionId: getChannel3CollectionId() ?? null, locale, limit });
    const providerToken = cursor === null ? undefined : decodeCatalogPageToken(cursor, binding);
    if (providerToken === null) return json(request, { error: 'Restart this catalog selection to load more products.' }, { status: 400 });
    const result = await browseCatalog({ categoryId: section?.categoryId, websiteId: retailer?.websiteId }, limit, locale, providerToken);
    const nextPageToken = result.next_page_token ? encodeCatalogPageToken(result.next_page_token, binding) : null;
    return json(
      request,
      {
        provider: 'Channel3',
        storefront: locale.country,
        currency: locale.currency,
        section: section?.id ?? null,
        retailer: retailer?.id ?? null,
        title: [section?.title, retailer?.title].filter(Boolean).join(" · "),
        limit,
        nextPageToken,
        retrievedAt: new Date().toISOString(),
        products: result.products.slice(0, limit),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch {
    return json(
      request,
      { error: 'The curated catalog is temporarily unavailable. Please try again later.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}

export function OPTIONS(request: NextRequest) {
  return handleMobileWebPreflight(request, ['GET']);
}
