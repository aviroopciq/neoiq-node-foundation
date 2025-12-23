/**
 * HTTP Client with observability, retry, and circuit breaker.
 *
 * Features:
 * - OpenTelemetry trace context propagation (traceparent header)
 * - Correlation ID propagation (x-request-id header)
 * - HTTP client metrics (request count, duration, errors)
 * - Automatic retries with exponential backoff
 * - Circuit breaker pattern
 *
 * Usage:
 *   import { createHttpClient } from '@commerceiq/neoiq-node-foundation';
 *
 *   const client = createHttpClient({
 *     baseURL: 'https://api.example.com',
 *     serviceName: 'example-api',
 *   });
 *
 *   const response = await client.get('/users');
 */

import axios, { AxiosInstance, AxiosRequestConfig, InternalAxiosRequestConfig, AxiosResponse } from 'axios';
import axiosRetry, { IAxiosRetryConfig } from 'axios-retry';
import CircuitBreaker from 'opossum';
import { trace, context, propagation } from '@opentelemetry/api';
import { logger, getMeter, getRequestContext } from './observability-index';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface HttpClientOptions {
  /**
   * Base URL for all requests.
   */
  baseURL: string;

  /**
   * Name of the target service (for metrics and logging).
   */
  serviceName: string;

  /**
   * Request timeout in milliseconds (default: 30000).
   */
  timeout?: number;

  /**
   * Retry configuration.
   */
  retry?: {
    /**
     * Maximum number of retries (default: 3).
     */
    retries?: number;

    /**
     * Base delay in milliseconds for exponential backoff (default: 1000).
     */
    retryDelay?: number;

    /**
     * HTTP status codes to retry on (default: [408, 429, 500, 502, 503, 504]).
     */
    retryStatusCodes?: number[];
  };

  /**
   * Circuit breaker configuration.
   */
  circuitBreaker?: {
    /**
     * Whether to enable circuit breaker (default: true).
     */
    enabled?: boolean;

    /**
     * Time in ms before attempting to close the circuit (default: 30000).
     */
    resetTimeout?: number;

    /**
     * Error percentage threshold to open the circuit (default: 50).
     */
    errorThresholdPercentage?: number;
  };

  /**
   * Additional default headers.
   */
  headers?: Record<string, string>;
}

// -----------------------------------------------------------------------------
// HTTP Client Factory
// -----------------------------------------------------------------------------

/**
 * Create a configured HTTP client with full observability.
 * Metrics are exported to OTEL Collector → Groundcover.
 */
export function createHttpClient(options: HttpClientOptions): AxiosInstance {
  const {
    baseURL,
    serviceName,
    timeout = 30000,
    retry = {},
    circuitBreaker: cbOptions = {},
    headers = {},
  } = options;

  // Create Axios instance
  const client = axios.create({
    baseURL,
    timeout,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });

  // Setup metrics (per Groundcover guide)
  const meter = getMeter(`http-client-${serviceName}`);
  const requestCounter = meter.createCounter('http.client.requests.total', {
    description: 'Total number of outbound HTTP requests',
  });
  const requestDuration = meter.createHistogram('http.client.request.duration', {
    description: 'Outbound HTTP request duration in milliseconds',
    unit: 'ms',
  });
  const requestErrors = meter.createCounter('http.client.requests.errors', {
    description: 'Total number of outbound HTTP request errors',
  });

  // ---------------------------------------------------------------------------
  // Request Interceptor - Add trace context and correlation ID
  // ---------------------------------------------------------------------------
  client.interceptors.request.use((config: InternalAxiosRequestConfig) => {
    // 1. Propagate OpenTelemetry trace context (W3C traceparent)
    const carrier: Record<string, string> = {};
    propagation.inject(context.active(), carrier);

    if (carrier.traceparent) {
      config.headers.set('traceparent', carrier.traceparent);
    }
    if (carrier.tracestate) {
      config.headers.set('tracestate', carrier.tracestate);
    }

    // 2. Propagate correlation ID
    const reqCtx = getRequestContext();
    if (reqCtx?.correlationId) {
      config.headers.set('x-request-id', reqCtx.correlationId);
    }

    // 3. Add timing metadata
    (config as any).__startTime = Date.now();

    // 4. Log outbound request
    logger.debug(
      {
        method: config.method?.toUpperCase(),
        url: `${config.baseURL || ''}${config.url}`,
        targetService: serviceName,
        correlationId: reqCtx?.correlationId,
      },
      'Outbound HTTP request'
    );

    return config;
  });

  // ---------------------------------------------------------------------------
  // Response Interceptor - Log and record metrics
  // ---------------------------------------------------------------------------
  client.interceptors.response.use(
    (response: AxiosResponse) => {
      const config = response.config as any;
      const durationMs = Date.now() - (config.__startTime || Date.now());
      const reqCtx = getRequestContext();

      const labels = {
        target_service: serviceName,
        method: config.method?.toUpperCase() || 'GET',
        status_code: String(response.status),
      };

      // Log success
      logger.debug(
        {
          method: config.method?.toUpperCase(),
          url: `${config.baseURL || ''}${config.url}`,
          targetService: serviceName,
          statusCode: response.status,
          durationMs,
          correlationId: reqCtx?.correlationId,
        },
        'Outbound HTTP response'
      );

      // Record metrics
      requestCounter.add(1, labels);
      requestDuration.record(durationMs, labels);

      return response;
    },
    (error) => {
      const config = error.config as any;
      const durationMs = config ? Date.now() - (config.__startTime || Date.now()) : 0;
      const statusCode = error.response?.status || 0;
      const reqCtx = getRequestContext();

      const labels = {
        target_service: serviceName,
        method: config?.method?.toUpperCase() || 'GET',
        status_code: String(statusCode),
      };

      // Log error
      logger.error(
        {
          method: config?.method?.toUpperCase(),
          url: config ? `${config.baseURL || ''}${config.url}` : 'unknown',
          targetService: serviceName,
          statusCode,
          durationMs,
          error: error.message,
          correlationId: reqCtx?.correlationId,
        },
        'Outbound HTTP error'
      );

      // Record metrics
      requestCounter.add(1, labels);
      requestDuration.record(durationMs, labels);
      requestErrors.add(1, labels);

      return Promise.reject(error);
    }
  );

  // ---------------------------------------------------------------------------
  // Configure Retry
  // ---------------------------------------------------------------------------
  const retryConfig: IAxiosRetryConfig = {
    retries: retry.retries ?? 3,
    retryDelay: (retryCount) => {
      const baseDelay = retry.retryDelay ?? 1000;
      return baseDelay * Math.pow(2, retryCount - 1); // Exponential backoff
    },
    retryCondition: (error) => {
      const retryStatusCodes = retry.retryStatusCodes ?? [408, 429, 500, 502, 503, 504];
      const status = error.response?.status;
      return !error.response || retryStatusCodes.includes(status || 0);
    },
    onRetry: (retryCount, error, requestConfig) => {
      logger.warn(
        {
          retryCount,
          url: `${requestConfig.baseURL || ''}${requestConfig.url}`,
          error: error.message,
          targetService: serviceName,
        },
        'Retrying HTTP request'
      );
    },
  };

  axiosRetry(client, retryConfig);

  // ---------------------------------------------------------------------------
  // Configure Circuit Breaker
  // ---------------------------------------------------------------------------
  if (cbOptions.enabled !== false) {
    const breaker = new CircuitBreaker(
      async (config: AxiosRequestConfig) => client.request(config),
      {
        timeout,
        resetTimeout: cbOptions.resetTimeout ?? 30000,
        errorThresholdPercentage: cbOptions.errorThresholdPercentage ?? 50,
        volumeThreshold: 10,
      }
    );

    breaker.on('open', () => {
      logger.warn({ targetService: serviceName, baseURL }, 'Circuit breaker OPEN');
    });

    breaker.on('halfOpen', () => {
      logger.info({ targetService: serviceName, baseURL }, 'Circuit breaker HALF-OPEN');
    });

    breaker.on('close', () => {
      logger.info({ targetService: serviceName, baseURL }, 'Circuit breaker CLOSED');
    });
  }

  return client;
}

// Convenience exports
export { AxiosInstance, AxiosRequestConfig, AxiosResponse };
