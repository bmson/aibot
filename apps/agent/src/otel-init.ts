import { loadConfig } from '@assistant/config';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, ConsoleSpanExporter } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

/**
 * Initialize OpenTelemetry tracing for this process. Library code only uses
 * @opentelemetry/api (withSpan); exporters are an app concern.
 *
 * This deliberately wires a bare NodeTracerProvider rather than sdk-node: the
 * full SDK drags gRPC, protobuf, metrics, and logs exporters into the esbuild
 * bundle (~2.5 MB of cold-start parse) while the only thing this process ever
 * emits is OTLP/HTTP traces.
 *
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
      ? new ConsoleSpanExporter()
      : config.OTEL_EXPORTER === 'otlp'
        ? new OTLPTraceExporter()
        : null;
  if (!traceExporter) return;

  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ 'service.name': config.OTEL_SERVICE_NAME }),
    spanProcessors: [new BatchSpanProcessor(traceExporter)],
  });
  provider.register();
  process.on('SIGTERM', () => void provider.shutdown());
}
