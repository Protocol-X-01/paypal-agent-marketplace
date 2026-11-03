import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { search } from "@/lib/channel3";

const inputSchema = z.object({
  query: z.string().trim().min(2).max(120),
  limit: z.number().int().min(1).max(8).optional(),
});

const WINDOW_MS = 60_000;
const MAX_SEARCHES_PER_WINDOW = 8;

type RateEntry = { startedAt: number; count: number };

const globalForSearch = globalThis as typeof globalThis & {
  __channel3Rate?: Map<string, RateEntry>;
};
const rate = (globalForSearch.__channel3Rate ??= new Map());

function clientAddress(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip") || "local";
}

function takeRateLimit(address: string, now: number): boolean {
  const current = rate.get(address);
  if (!current || now - current.startedAt >= WINDOW_MS) {
    rate.set(address, { startedAt: now, count: 1 });
  } else if (current.count >= MAX_SEARCHES_PER_WINDOW) {
    return false;
  } else {
    current.count += 1;
  }

  if (rate.size > 2_000) {
    for (const [key, entry] of rate) {
      if (now - entry.startedAt >= WINDOW_MS) rate.delete(key);
    }
  }
  return true;
}

function sameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: "Request origin is not allowed." }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Send a valid JSON search request." }, { status: 400 });
  }

  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Enter a search phrase between 2 and 120 characters." },
      { status: 400 },
    );
  }

  const query = parsed.data.query;
  const limit = parsed.data.limit ?? 6;
  const now = Date.now();

  if (!takeRateLimit(clientAddress(request), now)) {
    return NextResponse.json(
      { error: "Search is temporarily limited. Please wait a minute and try again." },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }

  try {
    const result = await search({ query, limit, mode: "default" });
    const retrievedAt = new Date().toISOString();

    return NextResponse.json(
      {
        provider: "Channel3",
        query,
        retrievedAt,
        products: result.products,
        nextPageToken: result.next_page_token ?? null,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { error: "The product catalog is temporarily unavailable. Please try again later." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
