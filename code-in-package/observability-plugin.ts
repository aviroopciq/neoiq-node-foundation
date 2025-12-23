/**
 * Fastify Observability Plugin
 *
 * Automatically handles:
 * - Correlation ID extraction/generation (x-request-id header)
 * - OpenTelemetry trace context propagation
 * - Request/response logging with trace context
 * - HTTP server metrics (request count, duration)
 *
 * Usage:
 *   import { observabilityPlugin } from '@commerceiq/neoiq-node-foundation';
 *   app.register(observabilityPlugin, { serviceName: 'my-service' });
 */

import { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { randomUUID } from 'crypto';
import { trace, context, propagation, SpanStatusCode, Span } from '@opentelemetry/api';
import { als, logger, getMeter, getRequestContext } from './observability-index';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface RequestContext {
  correlationId: string;
  traceId: string;
  spanId: string;
  startTime: number;
}

interface PluginOptions {
  /**
   * Service name for metrics (required).
   */
  serviceName: string;

  /**
   * Routes to exclude from tracing/metrics (e.g., ['/health']).
   */
  excludeRoutes?: string[];
}

// Extend FastifyRequest to store context
declare module 'fastify' {
  interface FastifyRequest {
    __span?: Span;
    __requestContext?: RequestContext;
  }
}

// -----------------------------------------------------------------------------
// Plugin Implementation
// -----------------------------------------------------------------------------

const plugin: FastifyPluginAsync<PluginOptions> = async (fastify, options) => {
  const { serviceName, excludeRoutes = ['/health', '/health/'] } = options;

  const tracer = trace.getTracer('neoiq-foundation');

  // Setup metrics (per Groundcover guide)
  const meter = getMeter(serviceName);
  const requestCounter = meter.createCounter('http.server.requests.total', {
    description: 'Total number of HTTP requests',
  });
  const requestDuration = meter.createHistogram('http.server.request.duration', {
    description: 'HTTP request duration in milliseconds',
    unit: 'ms',
  });
  const requestErrors = meter.createCounter('http.server.requests.errors', {
    description: 'Total number of HTTP request errors',
  });

  // ---------------------------------------------------------------------------
  // ON REQUEST - Extract context, start span
  // ---------------------------------------------------------------------------
  fastify.addHook('onRequest', (request, reply, done) => {
    // Skip health checks
    if (excludeRoutes.some((route) => request.url.startsWith(route))) {
      done();
      return;
    }

    // 1. Extract or generate correlation ID from x-request-id header
    const correlationId = (request.headers['x-request-id'] as string) || randomUUID();

    // 2. Set correlation ID in response header
    reply.header('x-request-id', correlationId);

    // 3. Extract parent trace context from incoming headers (W3C traceparent)
    const parentContext = propagation.extract(context.active(), request.headers);

    // 4. Start a new span for this request
    const span = tracer.startSpan(
      `${request.method} ${request.routeOptions?.url || request.url}`,
      {
        kind: 1, // SpanKind.SERVER
        attributes: {
          'http.method': request.method,
          'http.url': request.url,
          'http.route': request.routeOptions?.url || request.url,
          'http.user_agent': request.headers['user-agent'] || '',
          'http.correlation_id': correlationId,
        },
      },
      parentContext
    );

    // 5. Get trace/span IDs
    const spanContext = span.spanContext();
    const traceId = spanContext.traceId;
    const spanId = spanContext.spanId;

    // 6. Store context
    const requestContext: RequestContext = {
      correlationId,
      traceId,
      spanId,
      startTime: Date.now(),
    };

    request.__span = span;
    request.__requestContext = requestContext;

    // 7. Run in AsyncLocalStorage context
    als.run({ correlationId, traceId, spanId }, () => {
      logger.info(
        {
          correlationId,
          traceId,
          spanId,
          method: request.method,
          url: request.url,
          route: request.routeOptions?.url,
          userAgent: request.headers['user-agent'],
        },
        'Request received'
      );

      done();
    });
  });

  // ---------------------------------------------------------------------------
  // ON RESPONSE - End span, record metrics
  // ---------------------------------------------------------------------------
  fastify.addHook('onResponse', (request, reply, done) => {
    const ctx = request.__requestContext;
    const span = request.__span;

    if (!ctx) {
      done();
      return;
    }

    const durationMs = Date.now() - ctx.startTime;
    const route = request.routeOptions?.url || request.url;
    const labels = {
      method: request.method,
      route,
      status_code: String(reply.statusCode),
    };

    // Run in context for proper log correlation
    als.run({ correlationId: ctx.correlationId, traceId: ctx.traceId, spanId: ctx.spanId }, () => {
      // Log response
      logger.info(
        {
          correlationId: ctx.correlationId,
          traceId: ctx.traceId,
          spanId: ctx.spanId,
          method: request.method,
          url: request.url,
          route,
          statusCode: reply.statusCode,
          durationMs,
        },
        'Request completed'
      );

      // Record metrics (per Groundcover guide)
      requestCounter.add(1, labels);
      requestDuration.record(durationMs, labels);

      if (reply.statusCode >= 400) {
        requestErrors.add(1, labels);
      }

      // End span
      if (span) {
        span.setStatus({
          code: reply.statusCode < 400 ? SpanStatusCode.OK : SpanStatusCode.ERROR,
        });
        span.setAttribute('http.status_code', reply.statusCode);
        span.setAttribute('http.response_time_ms', durationMs);
        span.end();
      }

      done();
    });
  });

  // ---------------------------------------------------------------------------
  // ON ERROR - Record exception on span
  // ---------------------------------------------------------------------------
  fastify.addHook('onError', (request, reply, error, done) => {
    const ctx = request.__requestContext;
    const span = request.__span;

    if (!ctx) {
      done();
      return;
    }

    als.run({ correlationId: ctx.correlationId, traceId: ctx.traceId, spanId: ctx.spanId }, () => {
      logger.error(
        {
          correlationId: ctx.correlationId,
          traceId: ctx.traceId,
          spanId: ctx.spanId,
          method: request.method,
          url: request.url,
          error: error.message,
          stack: error.stack,
        },
        'Request failed'
      );

      if (span) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        span.recordException(error);
      }

      done();
    });
  });
};

// Export plugin
export const observabilityPlugin = fp(plugin, {
  name: 'neoiq-observability',
  fastify: '4.x',
});

// Re-export context helper
export { getRequestContext };
