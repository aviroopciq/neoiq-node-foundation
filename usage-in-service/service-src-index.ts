/**
 * Example: How to use @commerceiq/neoiq-node-foundation in a service
 *
 * Flow: App → OpenTelemetry SDK → OTEL Collector → Groundcover
 *
 * This file shows how canvas-weaver or similar services would integrate
 * the foundation library for full observability.
 */

// ============================================================================
// STEP 1: Initialize OTEL (must be first, before other imports)
// ============================================================================
import { init, logger, getMeter, observabilityPlugin, createHttpClient, shutdown } from '../code-in-package';

// Initialize OpenTelemetry - sends metrics & traces to OTEL Collector → Groundcover
init({
  serviceName: 'canvas-weaver',
  serviceVersion: '1.0.0',
  environment: process.env.NODE_ENV || 'development',
  // Uses OTEL_EXPORTER_OTLP_ENDPOINT env var, or defaults to cluster collector
});

// ============================================================================
// STEP 2: Import your app dependencies (AFTER init)
// ============================================================================
import Fastify from 'fastify';

// ============================================================================
// STEP 3: Create app with observability plugin
// ============================================================================
const app = Fastify({
  logger: false, // We use our own Pino logger with trace context
});

// Register observability plugin - handles tracing, metrics, logging automatically
app.register(observabilityPlugin, { serviceName: 'canvas-weaver' });

// ============================================================================
// STEP 4: Create HTTP clients for downstream services
// ============================================================================
const authClient = createHttpClient({
  baseURL: process.env.AUTH_SERVICE_URL || 'http://neoiq-auth-service:3000',
  serviceName: 'auth-service',
  retry: { retries: 3 },
});

const dataFetcherClient = createHttpClient({
  baseURL: process.env.DATA_FETCHER_URL || 'http://data-fetcher:8000',
  serviceName: 'data-fetcher',
  timeout: 60000, // Data fetcher can be slow
});

// ============================================================================
// STEP 5: Add custom business metrics (optional)
// ============================================================================
const meter = getMeter('canvas-weaver', '1.0.0');

// Custom counters
const reportCreatedCounter = meter.createCounter('reports.created.total', {
  description: 'Total number of reports created',
});
const feedbackCounter = meter.createCounter('feedback.submitted.total', {
  description: 'Total number of feedback submissions',
});

// Custom histograms
const nlqLatency = meter.createHistogram('nlq.query.duration', {
  description: 'NLQ query processing time in ms',
  unit: 'ms',
});

// ============================================================================
// STEP 6: Define routes
// ============================================================================
app.get('/health', async () => {
  return { status: 'ok', service: 'canvas-weaver' };
});

app.post('/api/v1/reports', async (request, reply) => {
  const startTime = Date.now();

  try {
    // Your business logic...
    logger.info({ reportId: 'xyz' }, 'Creating report');

    // Example: Call downstream service (trace context is propagated automatically)
    const authResponse = await authClient.get('/api/v1/validate-token');
    logger.debug({ valid: authResponse.data.valid }, 'Token validated');

    // Record custom metric
    reportCreatedCounter.add(1, { type: 'standard' });

    return { id: 'report-123', created: true };
  } catch (error: any) {
    logger.error({ error: error.message }, 'Failed to create report');
    reply.status(500).send({ error: 'Failed to create report' });
  }
});

app.post('/api/v1/ui-store/chat-feedback', async (request, reply) => {
  const { feedbackType } = request.body as any;

  // Record feedback metric
  feedbackCounter.add(1, { type: feedbackType });

  logger.info({ feedbackType }, 'Feedback submitted');

  return { success: true };
});

app.post('/api/v1/nlq', async (request, reply) => {
  const startTime = Date.now();

  try {
    // Call data-fetcher (trace context is propagated automatically)
    const response = await dataFetcherClient.post('/api/nlq', request.body);

    // Record latency
    const durationMs = Date.now() - startTime;
    nlqLatency.record(durationMs, { status: 'success' });

    logger.info({ durationMs }, 'NLQ query completed');

    return response.data;
  } catch (error: any) {
    const durationMs = Date.now() - startTime;
    nlqLatency.record(durationMs, { status: 'error' });

    logger.error({ error: error.message, durationMs }, 'NLQ query failed');
    reply.status(500).send({ error: 'Query failed' });
  }
});

// ============================================================================
// STEP 7: Start server with graceful shutdown
// ============================================================================
const start = async () => {
  try {
    const port = Number(process.env.PORT) || 3000;
    await app.listen({ port, host: '0.0.0.0' });
    logger.info({ port }, `Server started on port ${port}`);
  } catch (error) {
    logger.error({ error }, 'Failed to start server');
    process.exit(1);
  }
};

// Graceful shutdown - flush pending telemetry
const gracefulShutdown = async () => {
  logger.info({}, 'Shutting down...');
  await app.close();
  await shutdown(); // Flush OTEL data
  process.exit(0);
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

start();
