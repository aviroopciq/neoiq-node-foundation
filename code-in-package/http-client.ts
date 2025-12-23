// @commerceiq/neoiq-node-foundation/src/http/client.ts
import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import axiosRetry from 'axios-retry';
import CircuitBreaker from 'opossum';
import { trace, context, propagation } from '@opentelemetry/api';
import { logger } from '../observability';

export interface HttpClientOptions {
  baseURL: string;
  timeout?: number;
  retry?: { retries?: number; delay?: number };
  circuitBreaker?: { threshold?: number; timeout?: number };
}

export function createHttpClient(options: HttpClientOptions): AxiosInstance {
  const { baseURL, timeout = 30000, retry, circuitBreaker } = options;

  const client = axios.create({ baseURL, timeout });

  // 1. Inject trace headers on every request
  client.interceptors.request.use((config) => {
    const span = trace.getActiveSpan();
    if (span) {
      propagation.inject(context.active(), config.headers);
    }
    logger.debug({ url: config.url, method: config.method }, 'HTTP request started');
    return config;
  });

  // 2. Log responses
  client.interceptors.response.use(
    (response) => {
      logger.debug({ url: response.config.url, status: response.status }, 'HTTP request completed');
      return response;
    },
    (error) => {
      logger.error({ url: error.config?.url, status: error.response?.status }, 'HTTP request failed');
      throw error;
    }
  );

  // 3. Setup retry
  if (retry) {
    axiosRetry(client, {
      retries: retry.retries ?? 3,
      retryDelay: (count) => count * (retry.delay ?? 1000),
      retryCondition: (error) => error.response?.status! >= 500 || !error.response,
    });
  }

  // 4. Wrap with circuit breaker if configured
  if (circuitBreaker) {
    // Circuit breaker wraps the request method
    const breaker = new CircuitBreaker(
      async (config: AxiosRequestConfig) => client.request(config),
      {
        timeout: circuitBreaker.timeout ?? 10000,
        errorThresholdPercentage: 50,
        resetTimeout: 30000,
      }
    );
    
    breaker.on('open', () => logger.warn({ baseURL }, 'Circuit breaker opened'));
    breaker.on('close', () => logger.info({ baseURL }, 'Circuit breaker closed'));
  }

  return client;
}