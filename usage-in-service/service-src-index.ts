/**
 * canvas-weaver/src/index.ts
 * 
 * Example: How a service uses the foundation WITH the Fastify plugin
 */

import Fastify from 'fastify';
import { init, logger, observabilityPlugin, createHttpClient } from '@commerceiq/neoiq-node-foundation';

// 1. Initialize foundation FIRST
init({
  serviceName: 'canvas-weaver',
  environment: process.env.NODE_ENV || 'development',
  otlpEndpoint: process.env.OTEL_ENDPOINT,
});

const app = Fastify();

// 2. Register plugin — handles all request/response logging + context automatically
app.register(observabilityPlugin);

// 3. Create HTTP client for downstream services
const authService = createHttpClient({
  baseURL: 'http://neoiq-auth-service:3000',
  retry: { retries: 3 },
  circuitBreaker: { threshold: 5 },
});

// 4. Route handler — just focus on business logic
app.get('/api/v1/reports/:reportId', async (request, reply) => {
  const { reportId } = request.params as { reportId: string };
  
  // traceId and reqId are auto-included in all logs
  logger.info({ reportId }, 'Fetching report');

  // Trace headers auto-propagated to downstream services
  const authResponse = await authService.get('/api/v1/auth/validate', {
    headers: { Authorization: request.headers.authorization },
  });
  
  logger.info({ userId: authResponse.data.userId }, 'User authenticated');

  // ... fetch report data ...

  return { success: true, reportId };
});

// 5. Start server
app.listen({ port: 3000 }, () => {
  logger.info({ port: 3000 }, 'Server started');
});
