# @commerceiq/neoiq-node-foundation

A lightweight Node.js foundation library providing structured logging, distributed tracing, and resilient HTTP clients.

## Quick Start

```typescript
import { init, logger, observabilityPlugin, createHttpClient } from '@commerceiq/neoiq-node-foundation';

init({ serviceName: 'my-service' });

app.register(observabilityPlugin);

logger.info({ userId: 123 }, 'Hello world');
```

---

## How Distributed Tracing Works

### Single Request Flow

```
┌─────────────────────────────────────────────────────────────┐
│                    Incoming Request                         │
│                 x-request-id: "req-123"                     │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│              observabilityPlugin (onRequest)                │
│                                                             │
│  1. Extract x-request-id → correlationId                   │
│  2. Start OpenTelemetry span → traceId, spanId             │
│  3. Store in AsyncLocalStorage                              │
│  4. LOG: "Request received"                                 │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                    Route Handler                            │
│                                                             │
│  logger.info() → auto-includes correlationId, traceId       │
│  httpClient.get() → auto-propagates trace headers           │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│              observabilityPlugin (onResponse)               │
│                                                             │
│  1. LOG: "Request completed" with duration                  │
│  2. End OpenTelemetry span                                  │
└─────────────────────────────────────────────────────────────┘
```

---

### Cross-Service Tracing

```
┌─────────────────────────────────────────────────────────────────────┐
│                         canvas-weaver                               │
│                       traceId: abc123                               │
│                                                                     │
│   LOG: {"traceId":"abc123","msg":"Request received"}               │
│   LOG: {"traceId":"abc123","msg":"Calling auth-service"}           │
│                                                                     │
│   httpClient.get('/validate')                                       │
│   └─── sends header: traceparent: 00-abc123-span001-01             │
└─────────────────────────────┬───────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         auth-service                                │
│                       traceId: abc123  ← SAME!                      │
│                                                                     │
│   observabilityPlugin extracts traceId from traceparent header     │
│                                                                     │
│   LOG: {"traceId":"abc123","msg":"Request received"}               │
│   LOG: {"traceId":"abc123","msg":"Token validated"}                │
│   LOG: {"traceId":"abc123","msg":"Request completed"}              │
└─────────────────────────────┬───────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      back to canvas-weaver                          │
│                                                                     │
│   LOG: {"traceId":"abc123","msg":"Auth successful"}                │
│   LOG: {"traceId":"abc123","msg":"Request completed"}              │
└─────────────────────────────────────────────────────────────────────┘

🔍 Search "traceId: abc123" → See ENTIRE journey across all services!
```

---

## Log Output Example

```json
{"level":"info","time":1703347200000,"correlationId":"req-123","traceId":"abc123","spanId":"span001","method":"GET","url":"/api/reports/1","msg":"Request received"}
{"level":"info","time":1703347200050,"correlationId":"req-123","traceId":"abc123","spanId":"span001","reportId":"1","msg":"Fetching report"}
{"level":"info","time":1703347200100,"correlationId":"req-123","traceId":"abc123","spanId":"span001","userId":"456","msg":"User authenticated"}
{"level":"info","time":1703347200150,"correlationId":"req-123","traceId":"abc123","spanId":"span001","statusCode":200,"durationMs":150,"msg":"Request completed"}
```

---

## API Reference

### `init(options)`

Initialize the foundation. Call once at app startup.

```typescript
init({
  serviceName: 'my-service',         // Required
  environment: 'production',          // Optional, default: 'development'
  otlpEndpoint: 'http://tempo:4317',  // Optional, for trace export
  logLevel: 'info',                   // Optional: 'debug' | 'info' | 'warn' | 'error'
});
```

### `observabilityPlugin`

Fastify plugin that handles request lifecycle automatically.

```typescript
app.register(observabilityPlugin);
```

**What it does:**
- Extracts `x-request-id` header → `correlationId`
- Starts OpenTelemetry span → `traceId`, `spanId`
- Logs "Request received" and "Request completed" with duration
- Handles errors with full stack trace

### `logger`

Structured logger with automatic trace context injection.

```typescript
logger.info({ userId: 123 }, 'User logged in');
logger.error({ err }, 'Something failed');
logger.warn({ threshold: 0.8 }, 'High memory usage');
logger.debug({ query }, 'Database query');
```

### `createHttpClient(options)`

HTTP client with retry + circuit breaker + automatic trace propagation.

```typescript
const client = createHttpClient({
  baseURL: 'http://other-service:3000',
  timeout: 30000,                    // Optional, default: 30000ms
  retry: { retries: 3, delay: 1000 }, // Optional
  circuitBreaker: { threshold: 5 },   // Optional
});

// Trace headers automatically propagated
await client.get('/api/data');
await client.post('/api/create', { name: 'test' });
```

---

## Service Usage Example

```typescript
// canvas-weaver/src/index.ts
import Fastify from 'fastify';
import { init, logger, observabilityPlugin, createHttpClient } from '@commerceiq/neoiq-node-foundation';

// 1. Initialize
init({
  serviceName: 'canvas-weaver',
  environment: process.env.NODE_ENV,
  otlpEndpoint: process.env.OTEL_ENDPOINT,
});

const app = Fastify();

// 2. Register plugin
app.register(observabilityPlugin);

// 3. Create HTTP clients
const authService = createHttpClient({
  baseURL: 'http://auth-service:3000',
  retry: { retries: 3 },
});

// 4. Routes
app.get('/api/reports/:id', async (req) => {
  const { id } = req.params;
  
  logger.info({ reportId: id }, 'Fetching report');
  
  // Trace context auto-propagated
  const auth = await authService.get('/validate');
  
  logger.info({ userId: auth.data.userId }, 'Authenticated');
  
  return { success: true };
});

app.listen({ port: 3000 });
```

---

## Architecture

```
@commerceiq/neoiq-node-foundation/
│
├── observability/
│   ├── index.ts          # init(), logger
│   └── plugin.ts         # observabilityPlugin
│
└── http/
    └── client.ts         # createHttpClient
```

---

## Requirements

- Node.js >= 18
- Fastify 4.x (for observabilityPlugin)

## Dependencies

- `pino` - Structured logging
- `@opentelemetry/*` - Distributed tracing
- `axios` + `axios-retry` - HTTP client with retry
- `opossum` - Circuit breaker

---

## License

MIT

