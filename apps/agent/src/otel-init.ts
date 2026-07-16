import { loadConfig } from '@assistant/core';
import { NodeSDK, tracing } from '@opentelemetry/sdk-node';

/**
 * Initialize the OpenTelemetry SDK for this process. Library code only uses
 * @opentelemetry/api (withSpan); exporters are an app concern. 'none' keeps
 * the no-op tracer (zero overhead); 'otlp' is wired in Phase 7 (Cloud Trace).
 */
export function initOtel(): void {
  const config = loadConfig();
  if (config.OTEL_EXPORTER !== 'console') return;

  const sdk = new NodeSDK({
    serviceName: config.OTEL_SERVICE_NAME,
    traceExporter: new tracing.ConsoleSpanExporter(),
  });
  sdk.start();
  process.on('SIGTERM', () => void sdk.shutdown());
}
