import type { SpanContext } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";

const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const SAFE_ROUTES = new Set([
  "/", "/dashboard", "/agent/[id]", "/api/agents/[id]/chat",
  "/api/agents/[id]/wallet", "/api/health", "/api/market/chart/[coinId]",
  "/api/market/candles/[coinId]", "/api/market/coins",
  "/api/market/intraday/[coinId]", "/api/market/quotes", "/api/marketplace/catalog",
  "/api/marketplace/search", "/api/orders", "/api/webhooks/paypal",
]);

// These are framework-defined identifiers, not arbitrary request values.
// Review the list against the installed Next.js documentation on upgrades.
const SAFE_SPAN_TYPES = new Set([
  "BaseServer.handleRequest", "AppRender.getBodyResult", "AppRender.fetch",
  "AppRouteRouteHandlers.runHandler", "Render.getServerSideProps",
  "Render.getStaticProps", "Render.renderDocument", "ResolveMetadata.generateMetadata",
  "NextNodeServer.findPageComponents", "NextNodeServer.getLayoutOrPageModule",
  "NextNodeServer.startResponse",
]);

// Do not pass the SDK's original resource through: framework defaults can
// include environment-derived hostnames even with resource detection disabled.
const SAFE_RESOURCE = resourceFromAttributes({
  "service.name": "paypal-markets-companion",
  "deployment.environment.name": "production",
});

function firstAllowed(attributes: ReadableSpan["attributes"], keys: string[], allowed: ReadonlySet<string>): string | undefined {
  for (const key of keys) {
    const value = attributes[key];
    if (typeof value === "string" && allowed.has(value)) return value;
  }
  return undefined;
}

function safeAttributes(attributes: ReadableSpan["attributes"]): ReadableSpan["attributes"] {
  const safe: ReadableSpan["attributes"] = {};
  for (const key of ["http.method", "http.request.method"]) {
    const value = attributes[key];
    if (typeof value === "string" && METHODS.has(value)) safe[key] = value;
  }
  for (const key of ["http.status_code", "http.response.status_code"]) {
    const value = attributes[key];
    if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599) safe[key] = value;
  }
  for (const key of ["http.route", "next.route"]) {
    const value = attributes[key];
    if (typeof value === "string" && SAFE_ROUTES.has(value)) safe[key] = value;
  }
  const spanType = attributes["next.span_type"];
  if (typeof spanType === "string" && SAFE_SPAN_TYPES.has(spanType)) safe["next.span_type"] = spanType;
  if (typeof attributes["next.rsc"] === "boolean") safe["next.rsc"] = attributes["next.rsc"];
  return safe;
}

function safeSpanName(attributes: ReadableSpan["attributes"]): string {
  const route = firstAllowed(attributes, ["next.route", "http.route"], SAFE_ROUTES);
  const method = firstAllowed(attributes, ["http.method", "http.request.method"], METHODS);
  if (route && method) return `${method} ${route}`;
  const spanType = firstAllowed(attributes, ["next.span_type"], SAFE_SPAN_TYPES);
  return spanType ? `next.${spanType}` : "app.operation";
}

function safeSpanContext(value: SpanContext | undefined): SpanContext | undefined {
  if (!value || !/^(?!0{32}$)[a-f0-9]{32}$/.test(value.traceId)
      || !/^(?!0{16}$)[a-f0-9]{16}$/.test(value.spanId)
      || !Number.isInteger(value.traceFlags) || value.traceFlags < 0 || value.traceFlags > 255) return undefined;
  // traceState is not needed for this application and may contain upstream data.
  return { traceId: value.traceId, spanId: value.spanId, traceFlags: value.traceFlags, ...(typeof value.isRemote === "boolean" ? { isRemote: value.isRemote } : {}) };
}

/** Send only reviewed metadata to the configured processor. */
export class PrivacyFilterSpanProcessor implements SpanProcessor {
  constructor(private readonly delegate: SpanProcessor) {}

  // The configured BatchSpanProcessor needs no start notification. Never pass
  // its delegate the unfiltered mutable span or inbound parent context.
  onStart(): void {}

  onEnd(span: ReadableSpan): void {
    const spanContext = safeSpanContext(span.spanContext());
    if (!spanContext) return;
    const candidateParent = safeSpanContext(span.parentSpanContext);
    const parentSpanContext = candidateParent?.traceId === spanContext.traceId ? candidateParent : undefined;

    // Construct the ReadableSpan interface explicitly. Spreading a real SDK
    // span loses prototype methods/getters such as spanContext and duration.
    this.delegate.onEnd({
      name: safeSpanName(span.attributes),
      kind: span.kind,
      spanContext: () => spanContext,
      parentSpanContext,
      startTime: span.startTime,
      endTime: span.endTime,
      duration: span.duration,
      ended: span.ended,
      status: { code: span.status.code },
      attributes: safeAttributes(span.attributes),
      events: [],
      links: [],
      resource: SAFE_RESOURCE,
      instrumentationScope: { name: "paypal-markets.filtered" },
      droppedAttributesCount: 0,
      droppedEventsCount: 0,
      droppedLinksCount: 0,
    });
  }

  forceFlush(): Promise<void> { return this.delegate.forceFlush(); }
  shutdown(): Promise<void> { return this.delegate.shutdown(); }
}
