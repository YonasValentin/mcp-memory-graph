// ── Auth API Routes ───────────────────────────────────────────────────────

import type { AuthService } from '../../enterprise/auth.js';
import type { StorageBackend } from '../../enterprise/storage.js';
import type { Logger } from '../../enterprise/logger.js';
import type { UserRole, TenantPlan } from '../../enterprise/tenant.js';
import { v4 as uuidv4 } from 'uuid';

interface AuthRouteDeps {
  authService: AuthService;
  storage: StorageBackend;
  logger: Logger;
}

export async function registerAuthRoutes(app: any, deps: AuthRouteDeps): Promise<void> {
  const { authService, storage, logger } = deps;

  // ── POST /api/v1/auth/token ───────────────────────────────────────────
  // Generate a JWT token (for development/testing)
  app.post('/api/v1/auth/token', async (request: any, reply: any) => {
    const { tenant_id, user_id, role, plan } = request.body;

    if (!tenant_id || !user_id) {
      reply.code(400).send({ error: 'tenant_id and user_id are required' });
      return;
    }

    const token = await authService.generateToken({
      tenantId: tenant_id,
      userId: user_id,
      userRole: (role as UserRole) ?? 'editor',
      plan: (plan as TenantPlan) ?? 'free',
    });

    reply.send({ token, expires_in: '24h' });
  });

  // ── POST /api/v1/auth/api-key ─────────────────────────────────────────
  // Generate a long-lived API key
  app.post('/api/v1/auth/api-key', async (request: any, reply: any) => {
    const { tenant_id, user_id } = request.body;

    if (!tenant_id || !user_id) {
      reply.code(400).send({ error: 'tenant_id and user_id are required' });
      return;
    }

    const apiKey = await authService.generateApiKey(tenant_id, user_id);
    logger.info('API key generated', { tenantId: tenant_id, userId: user_id });

    reply.send({ api_key: apiKey });
  });

  // ── POST /api/v1/tenants ──────────────────────────────────────────────
  // Register a new tenant
  app.post('/api/v1/tenants', async (request: any, reply: any) => {
    const { name, plan } = request.body;

    if (!name) {
      reply.code(400).send({ error: 'name is required' });
      return;
    }

    const tenantId = uuidv4();
    const userId = uuidv4();

    // Create tenant in storage if supported
    if (storage.createTenantSchema) {
      await storage.createTenantSchema(tenantId);
    }

    // Generate initial token
    const token = await authService.generateToken({
      tenantId,
      userId,
      userRole: 'owner',
      plan: plan ?? 'free',
    });

    const apiKey = await authService.generateApiKey(tenantId, userId);

    logger.info('Tenant created', { tenantId, name });

    reply.code(201).send({
      tenant_id: tenantId,
      user_id: userId,
      name,
      plan: plan ?? 'free',
      token,
      api_key: apiKey,
    });
  });
}
