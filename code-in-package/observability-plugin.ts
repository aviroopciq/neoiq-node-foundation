/**
 * Observability Plugin - Full request lifecycle with tracing
 * 
 * Usage:
 *   import { observabilityPlugin } from '@commerceiq/neoiq-node-foundation';
 *   app.register(observabilityPlugin);
 */

import { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { randomUUID } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import { trace, context, propagation, SpanStatusCode } from '@opentelemetry/api';

// Full context for request lifecycle
interface RequestContext {
  correlationId: string;
  traceId: string;
  spanId: string;
  startTime: number;
}

const als = new AsyncLocalStorage<RequestContext>();

const plugin: FastifyPluginAsync = async (fastify) => {
  const tracer = trace.getTracer('neoiq-foundation');

  // ============ ON REQUEST ============
  fastify.addHook('onRequest', (request, reply, done) => {
    // 1. Extract from x-request-id header, display as correlationId
    const correlationId = (request.headers['x-request-id'] as string) || randomUUID();
    
    // 2. Extract trace context from incoming headers (propagated from upstream)
    const parentContext = propagation.extract(context.active(), request.headers);
    
    // 3. Start a new span for this request
    const span = tracer.startSpan(
      `${request.method} ${request.url}`,
      { attributes: { 'http.method': request.method, 'http.url': request.url } },
      parentContext
    );
    
    // 4. Get trace/span IDs
    const spanContext = span.spanContext();
    const traceId = spanContext.traceId;
    const spanId = spanContext.spanId;

    // 5. Store in AsyncLocalStorage for the entire request lifecycle
    const requestContext: RequestContext = {
      correlationId,
      traceId,
      spanId,
      startTime: Date.now(),
    };

    als.run(requestContext, () => {
      // 6. Log request received with full context
      fastify.log.info({
        correlationId,
        traceId,
        spanId,
        method: request.method,
        url: request.url,
        headers: {
          'user-agent': request.headers['user-agent'],
          'x-request-id': request.headers['x-request-id'],
        },
      }, 'Request received');

      // Store span on request for later use
      (request as any).__span = span;
      
      done();
    });
  });

  // ============ ON RESPONSE ============
  fastify.addHook('onResponse', (request, reply, done) => {
    const ctx = als.getStore();
    const span = (request as any).__span;
    const duration = ctx ? Date.now() - ctx.startTime : 0;

    // Log response with full context
    fastify.log.info({
      correlationId: ctx?.correlationId,
      traceId: ctx?.traceId,
      spanId: ctx?.spanId,
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      durationMs: duration,
    }, 'Request completed');

    // End the span
    if (span) {
      span.setStatus({ code: reply.statusCode < 400 ? SpanStatusCode.OK : SpanStatusCode.ERROR });
      span.setAttribute('http.status_code', reply.statusCode);
      span.setAttribute('http.duration_ms', duration);
      span.end();
    }

    done();
  });

  // ============ ON ERROR ============
  fastify.addHook('onError', (request, reply, error, done) => {
    const ctx = als.getStore();
    const span = (request as any).__span;

    // Log error with full context
    fastify.log.error({
      correlationId: ctx?.correlationId,
      traceId: ctx?.traceId,
      spanId: ctx?.spanId,
      method: request.method,
      url: request.url,
      error: error.message,
      stack: error.stack,
    }, 'Request failed');

    // Mark span as error
    if (span) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      span.recordException(error);
    }

    done();
  });
};

// Export plugin
export const observabilityPlugin = fp(plugin, {
  name: 'neoiq-observability',
  fastify: '4.x',
});

// Helper to get current request context (for use in route handlers)
export function getRequestContext(): RequestContext | undefined {
  return als.getStore();
}
