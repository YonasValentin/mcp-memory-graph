// ── Error Handler ─────────────────────────────────────────────────────────

import type { Logger } from '../../enterprise/logger.js';
import type { Metrics } from '../../enterprise/metrics.js';

export function createErrorHandler(logger: Logger, metrics: Metrics) {
  return function errorHandler(error: any, request: any, reply: any): void {
    const tenantId = request.tenantContext?.tenantId ?? 'unknown';
    const statusCode = error.statusCode ?? 500;
    const route = request.routeOptions?.url ?? request.url;

    if (statusCode >= 500) {
      logger.error('Internal server error', {
        error: error.message,
        stack: error.stack,
        tenantId,
        method: request.method,
        url: request.url,
      });
      metrics.incErrors(tenantId, route);
    }

    if (statusCode === 429) {
      reply.code(429).send({
        error: 'Too Many Requests',
        message: 'Rate limit exceeded. Please try again later.',
        retryAfter: error.retryAfter ?? 60,
      });
      return;
    }

    if (error.validation) {
      reply.code(400).send({
        error: 'Validation Error',
        message: error.message,
        details: error.validation,
      });
      return;
    }

    reply.code(statusCode).send({
      error: statusCode >= 500 ? 'Internal Server Error' : error.message,
      message: statusCode >= 500 ? 'An unexpected error occurred' : error.message,
    });
  };
}
