import { loadConfig } from '@assistant/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK, tracing } from '@opentelemetry/sdk-node';

/**
 * Initialize the OpenTelemetry SDK for this process. Library code only uses
 * @opentelemetry/api (withSpan); exporters are an app concern.
 * - 'none' (default): no-op tracer, zero overhead.
 * - 'console': spans to stdout, for local inspection.
 * - 'otlp': standard OTLP/HTTP export to OTEL_EXPORTER_OTLP_ENDPOINT (a
 *   collector sidecar or a managed endpoint — e.g. the Google Cloud OTLP
 *   ingest). The exporter reads its endpoint/headers from the standard
 *   OTEL_EXPORTER_OTLP_* env vars.
 */
export function initOtel(): void {
  const config = loadConfig();
  const traceExporter =
    config.OTEL_EXPORTER === 'console'
      ? new tracing.ConsoleSpanExporter()
      : config.OTEL_EXPORTER === 'otlp'
        ? new OTLPTraceExporter()
        : null;
  if (!traceExporter) return;

  const sdk = new NodeSDK({ serviceName: config.OTEL_SERVICE_NAME, traceExporter });
  sdk.start();
  process.on('SIGTERM', () => void sdk.shutdown());
}
