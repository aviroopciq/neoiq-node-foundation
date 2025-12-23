/**
 * OpenTelemetry initialization for Node.js services.
 *
 * Follows Groundcover Integration Guide - Option 2 (Via OTEL Collector)
 *
 * Flow: App → OpenTelemetry SDK → OTEL Collector → Groundcover
 *
 * Environment Variables:
 *   OTEL_EXPORTER_OTLP_ENDPOINT: Collector URL (default: cluster OTEL Collector)
 *   OTEL_SERVICE_NAME: Service name
 *   OTEL_SERVICE_VERSION: Service version (default: 1.0.0)
 *   OTEL_ENVIRONMENT: Deployment environment (default: development)
 *
 * Usage:
 *   import { init, logger, getMeter } from '@commerceiq/neoiq-node-foundation';
 *
 *   init({ serviceName: 'my-service' });
 *
 *   logger.info({ action: 'startup' }, 'Service started');
 *
 *   const meter = getMeter('my-service');
 *   const counter = meter.createCounter('requests_total');
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { Resource } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import { trace, metrics, SpanStatusCode } from '@opentelemetry/api';
import pino from 'pino';
import { AsyncLocalStorage } from 'async_hooks';

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

// Default OTEL Collector endpoint (per Groundcover guide - Kubernetes internal)
const DEFAULT_OTEL_COLLECTOR =
  'http://otel-stack-deployment-collector.observability.svc.cluster.local:4317';

export interface InitOptions {
  /**
   * Service name (required). Shows up in Groundcover.
   */
  serviceName: string;

  /**
   * Service version (default: 1.0.0).
   */
  serviceVersion?: string;

  /**
   * Deployment environment (default: development).
   */
  environment?: string;

  /**
   * OTEL Collector endpoint.
   * Default: http://otel-stack-deployment-collector.observability.svc.cluster.local:4317
   */
  otlpEndpoint?: string;

  /**
   * Log level (default: info).
   */
  logLevel?: 'debug' | 'info' | 'warn' | 'error';

  /**
   * Metrics export interval in ms (default: 5000 per Groundcover guide).
   */
  metricsIntervalMs?: number;
}

// -----------------------------------------------------------------------------
// Context Storage
// -----------------------------------------------------------------------------

export interface RequestContext {
  correlationId?: string;
  traceId?: string;
  spanId?: string;
}

export const als = new AsyncLocalStorage<RequestContext>();

// -----------------------------------------------------------------------------
// Module State
// -----------------------------------------------------------------------------

let sdk: NodeSDK | null = null;
let meterProvider: MeterProvider | null = null;
let baseLogger: pino.Logger;
let serviceName: string = 'unknown';
let initialized = false;

// -----------------------------------------------------------------------------
// Initialization
// -----------------------------------------------------------------------------

/**
 * Initialize OpenTelemetry SDK with traces and metrics.
 *
 * Sends telemetry to OTEL Collector which forwards to Groundcover.
 * Call this at the very start of your application, before other imports.
 *
 * @example
 *   init({ serviceName: 'canvas-weaver' });
 */
export function init(options: InitOptions): void {
  if (initialized) {
    console.warn('[neoiq-foundation] Already initialized, skipping...');
    return;
  }

  const {
    serviceName: svcName,
    serviceVersion = process.env.OTEL_SERVICE_VERSION || '1.0.0',
    environment = process.env.OTEL_ENVIRONMENT || 'development',
    otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || DEFAULT_OTEL_COLLECTOR,
    logLevel = (process.env.LOG_LEVEL as any) || 'info',
    metricsIntervalMs = 5000, // 5 seconds per Groundcover guide
  } = options;

  serviceName = svcName;

  // 1. Create Resource (attached to all telemetry)
  const resource = new Resource({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_VERSION]: serviceVersion,
    'deployment.environment': environment,
  });

  // 2. Setup Metrics Exporter (per Groundcover guide)
  const metricExporter = new OTLPMetricExporter({ url: otlpEndpoint });
  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: metricsIntervalMs,
  });
  meterProvider = new MeterProvider({
    resource,
    readers: [metricReader],
  });
  metrics.setGlobalMeterProvider(meterProvider);

  // 3. Setup Trace Exporter
  const traceExporter = new OTLPTraceExporter({ url: otlpEndpoint });

  // 4. Initialize NodeSDK with auto-instrumentation
  sdk = new NodeSDK({
    resource,
    traceExporter,
    instrumentations: [
      getNodeAutoInstrumentations({
        // Disable fs instrumentation (too noisy)
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });

  sdk.start();

  // 5. Setup Pino logger with trace context injection
  baseLogger = pino({
    level: logLevel,
    base: {
      service: serviceName,
      version: serviceVersion,
      env: environment,
    },
    mixin: () => {
      // Inject trace context into every log (correlates logs with traces in Groundcover)
      const span = trace.getActiveSpan();
      const ctx = als.getStore();
      const spanContext = span?.spanContext();

      return {
        traceId: spanContext?.traceId || ctx?.traceId,
        spanId: spanContext?.spanId || ctx?.spanId,
        correlationId: ctx?.correlationId,
      };
    },
    formatters: {
      level: (label) => ({ level: label }),
    },
    transport:
      environment === 'development'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
  });

  baseLogger.info(
    {
      endpoint: otlpEndpoint,
      metricsInterval: `${metricsIntervalMs}ms`,
    },
    `OpenTelemetry initialized. Sending to OTEL Collector.`
  );

  initialized = true;
}

// -----------------------------------------------------------------------------
// Logger API
// -----------------------------------------------------------------------------

/**
 * Structured logger with automatic trace context injection.
 * All logs include traceId, spanId, and correlationId when available.
 */
export const logger = {
  info: (obj: object, msg?: string) => baseLogger?.info(obj, msg),
  error: (obj: object, msg?: string) => baseLogger?.error(obj, msg),
  warn: (obj: object, msg?: string) => baseLogger?.warn(obj, msg),
  debug: (obj: object, msg?: string) => baseLogger?.debug(obj, msg),
  child: (bindings: object) => baseLogger?.child(bindings),
};

// -----------------------------------------------------------------------------
// Tracer API
// -----------------------------------------------------------------------------

/**
 * Get a tracer instance for creating spans.
 *
 * @param name - Tracer name (defaults to service name)
 *
 * @example
 *   const tracer = getTracer();
 *   tracer.startActiveSpan('db.query', (span) => {
 *     // ... do work
 *     span.end();
 *   });
 */
export function getTracer(name?: string) {
  return trace.getTracer(name || serviceName);
}

// -----------------------------------------------------------------------------
// Meter API
// -----------------------------------------------------------------------------

/**
 * Get a meter instance for creating metrics.
 * Metrics are exported to OTEL Collector → Groundcover.
 *
 * @param name - Meter name (typically service name)
 * @param version - Meter version (default: 1.0.0)
 *
 * @example
 *   const meter = getMeter('canvas-weaver');
 *   const counter = meter.createCounter('http.requests.total');
 *   counter.add(1, { method: 'GET', route: '/api/reports' });
 *
 *   const histogram = meter.createHistogram('http.request.duration');
 *   histogram.record(150, { method: 'GET', route: '/api/reports' });
 */
export function getMeter(name: string, version: string = '1.0.0') {
  return metrics.getMeter(name, version);
}

// -----------------------------------------------------------------------------
// Context Helpers
// -----------------------------------------------------------------------------

/**
 * Get current request context from AsyncLocalStorage.
 */
export function getRequestContext(): RequestContext | undefined {
  return als.getStore();
}

/**
 * Run a function with a specific context (for manual context propagation).
 */
export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return als.run(ctx, fn);
}

/**
 * Get current trace context as a dictionary.
 * Useful for logging or passing to external systems.
 */
export function getTraceContext(): { traceId?: string; spanId?: string } {
  const span = trace.getActiveSpan();
  if (!span) return {};

  const ctx = span.spanContext();
  return {
    traceId: ctx.traceId,
    spanId: ctx.spanId,
  };
}

// -----------------------------------------------------------------------------
// Shutdown
// -----------------------------------------------------------------------------

/**
 * Gracefully shutdown OTEL providers.
 * Call this on application shutdown to flush pending telemetry.
 */
export async function shutdown(): Promise<void> {
  if (!initialized) return;

  try {
    await meterProvider?.shutdown();
    await sdk?.shutdown();
    console.log('[neoiq-foundation] OTEL shutdown complete');
  } catch (error) {
    console.error('[neoiq-foundation] Error during shutdown:', error);
  }
}

// Export for convenience
export { SpanStatusCode };
