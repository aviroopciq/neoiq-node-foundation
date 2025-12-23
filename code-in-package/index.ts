/**
 * @commerceiq/neoiq-node-foundation
 *
 * Node.js observability foundation for CommerceIQ services.
 * Integrates with Groundcover via OpenTelemetry.
 *
 * Flow: App → OpenTelemetry SDK → OTEL Collector → Groundcover
 */

// Core initialization and logging
export {
  init,
  logger,
  getTracer,
  getMeter,
  getRequestContext,
  runWithContext,
  getTraceContext,
  shutdown,
  als,
  SpanStatusCode,
  type InitOptions,
  type RequestContext,
} from './observability-index';

// Fastify plugin
export { observabilityPlugin } from './observability-plugin';

// HTTP client
export { createHttpClient, type HttpClientOptions } from './http-client';

