# neoiq-node-foundation

A lightweight Node.js foundation library providing structured JSON logging, OpenTelemetry integration, and resilient HTTP clients for modern microservices.

## Features

- **Structured Logging** - Pino-based JSON logs with automatic trace context injection
- **Distributed Tracing** - OpenTelemetry setup with one-liner initialization
- **HTTP Client** - Axios wrapper with retry + circuit breaker built-in
- **Type-safe Config** - Zod-validated configuration loading

## Installation

```bash
npm install @commerceiq/neoiq-node-foundation
```

## Quick Start

```typescript
import { init, logger } from '@commerceiq/neoiq-node-foundation';

// Initialize once at app startup
init({ serviceName: 'my-service', environment: 'production' });

// Logging - automatically includes traceId
logger.info({ userId: 123 }, 'Processing request');
```

## License

MIT
