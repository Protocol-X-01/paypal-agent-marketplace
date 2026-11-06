import { diag, DiagLogLevel } from "@opentelemetry/api";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";

// The official exporter merges OTLP environment headers with explicit headers.
// Construct it without inherited extras, then restore the process environment.
export function withoutOtlpEnvironmentHeaders<T>(create: () => T): T {
  const names = ["OTEL_EXPORTER_OTLP_HEADERS", "OTEL_EXPORTER_OTLP_TRACES_HEADERS"] as const;
  const previous = names.map((name) => process.env[name]);
  try {
    for (const name of names) delete process.env[name];
    return create();
  } finally {
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    });
  }
}

// OpenTelemetry's diagnostic messages can contain spans, collector responses,
// or endpoint details. Keep useful signals without forwarding their contents.
export function configureTelemetryDiagnostics(): boolean {
  // @vercel/otel otherwise replaces our logger with a console logger when this
  // variable is set. This applies only after production export is enabled.
  process.env.OTEL_LOG_LEVEL = "";
  return diag.setLogger(
    {
      error: () => console.error("[observability] OpenTelemetry reported an error; details withheld."),
      warn: (message) => {
        if (message === "Received Partial Success response:") {
          console.warn("[observability] The collector reported partial trace acceptance.");
        } else {
          console.warn("[observability] OpenTelemetry reported a warning; details withheld.");
        }
      },
      info: () => {},
      debug: () => {},
      verbose: () => {},
    },
    { logLevel: DiagLogLevel.WARN, suppressOverrideMessage: true },
  );
}

// Exporters may attach the collector's response body to errors. Never pass it
// to the SDK's global error handler, which may eventually write it to logs.
export class PrivacySafeSpanExporter implements SpanExporter {
  constructor(private readonly delegate: SpanExporter) {}

  export(spans: ReadableSpan[], callback: Parameters<SpanExporter["export"]>[1]): void {
    let settled = false;
    const finish: Parameters<SpanExporter["export"]>[1] = (result) => {
      if (settled) return;
      settled = true;
      callback(result.code === 0
        ? { code: 0 }
        : { code: 1, error: new Error("Trace export failed.") });
    };
    try {
      this.delegate.export(spans, finish);
    } catch (error) {
      if (settled) throw error;
      finish({ code: 1 });
    }
  }

  async forceFlush(): Promise<void> {
    try {
      await this.delegate.forceFlush?.();
    } catch {
      throw new Error("Trace export failed.");
    }
  }

  async shutdown(): Promise<void> {
    try {
      await this.delegate.shutdown();
    } catch {
      throw new Error("Trace exporter shutdown failed.");
    }
  }
}
