// ── Authentication Middleware ──────────────────────────────────────────────

import type { AuthService } from '../../enterprise/auth.js';
import type { TenantContext } from '../../enterprise/tenant.js';
import type { Logger } from '../../enterprise/logger.js';

declare module 'fastify' {
  interface FastifyRequest {
    tenantContext: TenantContext;
  }
}

export function createAuthMiddleware(authService: AuthService, logger: Logger) {
  return async function authenticate(request: any, reply: any): Promise<void> {
    const authHeader = request.headers.authorization;

    if (!authHeader) {
      reply.code(401).send({ error: 'Unauthorized', message: 'Missing Authorization header' });
      return;
    }

    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : authHeader;

    try {
      const ctx = await authService.verifyToken(token);
      request.tenantContext = ctx;
    } catch (err) {
      logger.warn('Authentication failed', {
        error: err instanceof Error ? err.message : String(err),
        ip: request.ip,
      });
      reply.code(401).send({ error: 'Unauthorized', message: 'Invalid or expired token' });
    }
  };
}
