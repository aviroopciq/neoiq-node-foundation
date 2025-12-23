// @commerceiq/neoiq-node-foundation/src/observability/index.ts
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import pino from 'pino';
import { trace, context, SpanStatusCode } from '@opentelemetry/api';
import { AsyncLocalStorage } from 'async_hooks';

// Context storage
const als = new AsyncLocalStorage<{ traceId?: string; spanId?: string; reqId?: string }>();

let sdk: NodeSDK;
let baseLogger: pino.Logger;

export interface InitOptions {
  serviceName: string;
  environment?: string;
  otlpEndpoint?: string;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
}

export function init(options: InitOptions) {
  const { serviceName, environment = 'development', otlpEndpoint, logLevel = 'info' } = options;

  // 1. Setup OpenTelemetry
  sdk = new NodeSDK({
    serviceName,
    traceExporter: otlpEndpoint 
      ? new OTLPTraceExporter({ url: otlpEndpoint })
      : undefined, // Console in dev
    instrumentations: [getNodeAutoInstrumentations()],
  });
  sdk.start();

  // 2. Setup Pino with trace injection
  baseLogger = pino({
    level: logLevel,
    base: { service: serviceName, env: environment },
    mixin: () => {
      // Inject trace context into every log
      const span = trace.getActiveSpan();
      const ctx = als.getStore();
      return {
        traceId: span?.spanContext().traceId || ctx?.traceId,
        spanId: span?.spanContext().spanId || ctx?.spanId,
        reqId: ctx?.reqId,
      };
    },
    transport: environment === 'development' 
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
  });

  console.log(`[neoiq-foundation] Initialized for ${serviceName}`);
}

// Logger API
export const logger = {
  info: (obj: object, msg?: string) => baseLogger.info(obj, msg),
  error: (obj: object, msg?: string) => baseLogger.error(obj, msg),
  warn: (obj: object, msg?: string) => baseLogger.warn(obj, msg),
  debug: (obj: object, msg?: string) => baseLogger.debug(obj, msg),
};

// Tracer API
export function getTracer(name: string) {
  return trace.getTracer(name);
}

// Context helpers
export function runWithContext<T>(ctx: { reqId?: string }, fn: () => T): T {
  return als.run(ctx, fn);
}

export function shutdown() {
  sdk?.shutdown();
}