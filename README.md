# @commerceiq/neoiq-node-foundation

Node.js observability foundation for CommerceIQ services. Integrates with **Groundcover** via **OpenTelemetry**.

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Your Service  │────▶│  OTEL Collector │────▶│   Groundcover   │
│  (canvas-weaver)│     │   (in-cluster)  │     │   (dashboard)   │
└─────────────────┘     └─────────────────┘     └─────────────────┘
        │                        │
        ├── Traces ──────────────┤
        ├── Metrics ─────────────┤
        └── Logs ────────────────┘
```

## Features

- **Traces**: Automatic span creation for HTTP requests (incoming & outgoing)
- **Metrics**: HTTP request counts, durations, errors + custom business metrics
- **Logs**: Structured JSON logs with automatic trace context (traceId, spanId, correlationId)
- **Fastify Plugin**: One-line integration for request lifecycle
- **HTTP Client**: Axios wrapper with retry, circuit breaker, and trace propagation

## Quick Start

### 1. Install

```bash
npm install @commerceiq/neoiq-node-foundation

# Peer dependencies
npm install @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/sdk-metrics \
  @opentelemetry/exporter-trace-otlp-grpc @opentelemetry/exporter-metrics-otlp-grpc \
  @opentelemetry/auto-instrumentations-node pino axios axios-retry opossum fastify-plugin
```

### 2. Initialize (First Line of Your App)

```typescript
import { init, logger, observabilityPlugin } from '@commerceiq/neoiq-node-foundation';

// Must be called BEFORE other imports
init({
  serviceName: 'canvas-weaver',
  serviceVersion: '1.0.0',
});
```

### 3. Add Fastify Plugin

```typescript
import Fastify from 'fastify';

const app = Fastify();
app.register(observabilityPlugin, { serviceName: 'canvas-weaver' });
```

### 4. Set Environment Variable in Kubernetes

```yaml
env:
  - name: OTEL_EXPORTER_OTLP_ENDPOINT
    value: 'http://otel-stack-deployment-collector.observability.svc.cluster.local:4317'
```

That's it! Your traces and metrics will flow to Groundcover.

---

## API Reference

### `init(options)`

Initialize OpenTelemetry. **Must be called before other imports.**

```typescript
init({
  serviceName: 'my-service',           // Required
  serviceVersion: '1.0.0',             // Default: '1.0.0'
  environment: 'production',           // Default: 'development'
  otlpEndpoint: 'http://...:4317',     // Default: cluster OTEL Collector
  logLevel: 'info',                    // 'debug' | 'info' | 'warn' | 'error'
  metricsIntervalMs: 5000,             // Default: 5000 (5 seconds)
});
```

### `logger`

Structured logger with automatic trace context injection.

```typescript
import { logger } from '@commerceiq/neoiq-node-foundation';

logger.info({ userId: '123' }, 'User logged in');
logger.error({ error: err.message }, 'Failed to process');
```

**Log Output:**
```json
{
  "level": "info",
  "time": 1703318400000,
  "service": "canvas-weaver",
  "traceId": "abc123...",
  "spanId": "def456...",
  "correlationId": "req-789",
  "userId": "123",
  "msg": "User logged in"
}
```

### `getMeter(name, version?)`

Get a meter for custom metrics.

```typescript
import { getMeter } from '@commerceiq/neoiq-node-foundation';

const meter = getMeter('canvas-weaver');

// Counter
const counter = meter.createCounter('reports.created.total');
counter.add(1, { type: 'standard' });

// Histogram
const histogram = meter.createHistogram('nlq.query.duration');
histogram.record(150, { status: 'success' });
```

### `observabilityPlugin`

Fastify plugin for automatic request handling.

```typescript
import { observabilityPlugin } from '@commerceiq/neoiq-node-foundation';

app.register(observabilityPlugin, {
  serviceName: 'my-service',
  excludeRoutes: ['/health', '/metrics'],
});
```

**Automatically:**
- Extracts/generates correlation ID (x-request-id header)
- Creates OpenTelemetry spans for each request
- Logs request received/completed with full context
- Records HTTP metrics (http.server.requests.total, http.server.request.duration)

### `createHttpClient(options)`

Create an Axios client with full observability.

```typescript
import { createHttpClient } from '@commerceiq/neoiq-node-foundation';

const authClient = createHttpClient({
  baseURL: 'http://auth-service:3000',
  serviceName: 'auth-service',
  timeout: 10000,
  retry: { retries: 3 },
});

const response = await authClient.get('/api/validate');
```

**Automatically:**
- Propagates trace context (traceparent header)
- Propagates correlation ID (x-request-id header)
- Logs outbound requests/responses
- Records HTTP client metrics
- Retries on 5xx errors with exponential backoff
- Circuit breaker protection

---

## Complete Example

```typescript
// src/index.ts

// STEP 1: Initialize OTEL (must be first!)
import { init, logger, getMeter, observabilityPlugin, createHttpClient, shutdown } from '@commerceiq/neoiq-node-foundation';

init({ serviceName: 'canvas-weaver' });

// STEP 2: Import dependencies
import Fastify from 'fastify';

const app = Fastify();

// STEP 3: Register plugin
app.register(observabilityPlugin, { serviceName: 'canvas-weaver' });

// STEP 4: Create HTTP clients
const authClient = createHttpClient({
  baseURL: process.env.AUTH_SERVICE_URL,
  serviceName: 'auth-service',
});

// STEP 5: Custom metrics
const meter = getMeter('canvas-weaver');
const feedbackCounter = meter.createCounter('feedback.submitted.total');

// STEP 6: Routes
app.post('/api/feedback', async (req, reply) => {
  const { type } = req.body as any;
  
  feedbackCounter.add(1, { type });
  logger.info({ type }, 'Feedback submitted');
  
  return { success: true };
});

// STEP 7: Start with graceful shutdown
app.listen({ port: 3000 });

process.on('SIGTERM', async () => {
  await app.close();
  await shutdown(); // Flush telemetry
});
```

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTEL Collector URL | `http://otel-stack-deployment-collector.observability.svc.cluster.local:4317` |
| `OTEL_SERVICE_VERSION` | Service version | `1.0.0` |
| `OTEL_ENVIRONMENT` | Deployment environment | `development` |
| `LOG_LEVEL` | Log level | `info` |

---

## What Gets Sent to Groundcover

### Traces
- Every HTTP request (incoming and outgoing)
- Correlation ID linking requests across services
- Span attributes: method, url, status_code, duration

### Metrics
- `http.server.requests.total` - Incoming request count
- `http.server.request.duration` - Incoming request latency
- `http.server.requests.errors` - Incoming request errors
- `http.client.requests.total` - Outgoing request count
- `http.client.request.duration` - Outgoing request latency
- Custom business metrics you define

### Logs
- Structured JSON with traceId, spanId, correlationId
- Automatically correlated with traces in Groundcover

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        Your Service                               │
├──────────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  │
│  │   init()        │  │ observability   │  │ createHttp      │  │
│  │                 │  │ Plugin          │  │ Client          │  │
│  │ - NodeSDK       │  │                 │  │                 │  │
│  │ - MeterProvider │  │ - Spans         │  │ - Trace prop    │  │
│  │ - Logger        │  │ - Metrics       │  │ - Metrics       │  │
│  │ - Auto-instr    │  │ - Logging       │  │ - Retry         │  │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘  │
│           │                    │                    │            │
│           └────────────────────┼────────────────────┘            │
│                                │                                  │
│                    ┌───────────▼───────────┐                     │
│                    │   OTLP Exporter       │                     │
│                    │   (gRPC :4317)        │                     │
│                    └───────────┬───────────┘                     │
└────────────────────────────────┼─────────────────────────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │    OTEL Collector       │
                    │    (in Kubernetes)      │
                    └────────────┬────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │      Groundcover        │
                    │   (Traces, Metrics,     │
                    │    Logs Dashboard)      │
                    └─────────────────────────┘
```

---

## Comparison with data-fetcher (Python)

| Feature | data-fetcher (Python) | neoiq-node-foundation |
|---------|----------------------|----------------------|
| Traces | ✅ OTLPSpanExporter | ✅ OTLPTraceExporter |
| Metrics | ✅ OTLPMetricExporter | ✅ OTLPMetricExporter |
| Auto-instrumentation | ✅ HTTPXInstrumentor | ✅ getNodeAutoInstrumentations |
| Logging | ✅ LoggingInstrumentor | ✅ Pino with trace injection |
| Default endpoint | Cluster OTEL Collector | Cluster OTEL Collector |
| Metrics interval | 60 seconds | 5 seconds (per guide) |

---

## References

- [Groundcover OpenTelemetry Integration Guide](./INFRA-Groundcover%20%26%20OpenTelemetry%20Integration%20Guide-231225-085908.pdf)
- [OpenTelemetry Node.js Documentation](https://opentelemetry.io/docs/languages/js/)
- [Groundcover Documentation](https://docs.groundcover.com/)

