import { PrivacyFilterSpanProcessor } from "@/lib/telemetry-privacy";
import { configureTelemetryDiagnostics, PrivacySafeSpanExporter, withoutOtlpEnvironmentHeaders } from "@/lib/telemetry-exporter";

const SERVICE_NAME = "paypal-markets-companion";

function getTraceEndpoint(value: string): string | undefined {
  try {
    const endpoint = new URL(value);
    const hostname = endpoint.hostname.toLowerCase();
    const isLocalhost =
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname === "127.0.0.1" ||
      hostname === "[::1]";

    if (
      endpoint.protocol !== "https:" ||
      !endpoint.hostname ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      isLocalhost
    ) {
      return undefined;
    }

    const base = endpoint.href.endsWith("/") ? endpoint.href : `${endpoint.href}/`;
    return new URL("v1/traces", base).toString();
  } catch {
    return undefined;
  }
}

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Next.js and @vercel/otel otherwise include outbound fetch URLs in spans.
  // This app's marketplace search terms can appear in those URLs.
  process.env.NEXT_OTEL_FETCH_DISABLED = "1";

  // NODE_ENV is also "production" for local `next start` builds. Export only
  // when explicitly enabled on production Render, never on a PR preview.
  if (
    process.env.NODE_ENV !== "production" ||
    process.env.RENDER !== "true" ||
    process.env.IS_PULL_REQUEST === "true" ||
    process.env.PAYPAL_ELASTIC_EXPORT_ENABLED !== "true"
  ) {
    return;
  }

  const endpoint = process.env.ELASTIC_OTLP_ENDPOINT?.trim();
  // This key belongs to the PayPal Observability project. Do not reuse the
  // generic Elastic key, which may belong to an unrelated security project.
  const apiKey = process.env.PAYPAL_ELASTIC_OTLP_API_KEY?.trim();
  const missing = [
    !endpoint && "ELASTIC_OTLP_ENDPOINT",
    !apiKey && "PAYPAL_ELASTIC_OTLP_API_KEY",
  ].filter((name): name is string => Boolean(name));

  if (missing.length > 0) {
    if (process.env.NODE_ENV === "production") {
      console.info(
        `[observability] Elastic export disabled; configure server-side ${missing.join(" and ")}.`,
      );
    }
    return;
  }

  const traceEndpoint = getTraceEndpoint(endpoint!);
  if (!traceEndpoint || /[\r\n,]/.test(apiKey!)) {
    console.warn(
      "[observability] Elastic export disabled; ELASTIC_OTLP_ENDPOINT must be a valid HTTPS OTLP base URL and PAYPAL_ELASTIC_OTLP_API_KEY must be a single-line key.",
    );
    return;
  }

  // The exporter can include collector response bodies and telemetry in
  // diagnostic output. Fail closed if a redacting logger cannot be installed.
  if (!configureTelemetryDiagnostics()) {
    console.warn("[observability] Elastic export disabled; safe diagnostics could not be configured.");
    return;
  }

  const [{ OTLPTraceExporter }, { registerOTel }, { BatchSpanProcessor }] =
    await Promise.all([
      import("@opentelemetry/exporter-trace-otlp-proto"),
      import("@vercel/otel"),
      import("@opentelemetry/sdk-trace-base"),
    ]);

  const exporter = withoutOtlpEnvironmentHeaders(() => new PrivacySafeSpanExporter(new OTLPTraceExporter({
    url: traceEndpoint,
    headers: { Authorization: `ApiKey ${apiKey}` },
    timeoutMillis: 10_000,
  })));
  const processor = new PrivacyFilterSpanProcessor(
    new BatchSpanProcessor(exporter),
  );

  // Pin a non-sensitive service name even if a platform-level OTEL_SERVICE_NAME
  // is set. Do not import trace context or baggage from request headers.
  process.env.OTEL_SERVICE_NAME = SERVICE_NAME;
  registerOTel({
    serviceName: SERVICE_NAME,
    autoDetectResources: false,
    attributes: {
      "deployment.environment.name":
        process.env.NODE_ENV === "production" ? "production" : "development",
    },
    instrumentations: [],
    propagators: ["none"],
    spanProcessors: [processor],
  });
}
