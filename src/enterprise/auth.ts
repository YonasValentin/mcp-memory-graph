// ── JWT Authentication ────────────────────────────────────────────────────

import type { EnterpriseConfig } from './config.js';
import type { TenantContext, TenantPlan, UserRole } from './tenant.js';

export interface AuthService {
  generateToken(payload: TokenPayload): Promise<string>;
  verifyToken(token: string): Promise<TenantContext>;
  generateApiKey(tenantId: string, userId: string): Promise<string>;
}

export interface TokenPayload {
  tenantId: string;
  userId: string;
  userRole: UserRole;
  plan: TenantPlan;
}

class JoseAuthService implements AuthService {
  private secret: Uint8Array;
  private issuer: string;
  private audience: string;
  private expiryHours: number;

  constructor(config: EnterpriseConfig['auth']) {
    if (!config.jwtSecret || config.jwtSecret.length < 32) {
      throw new Error('JWT_SECRET must be at least 32 characters');
    }
    this.secret = new TextEncoder().encode(config.jwtSecret);
    this.issuer = config.issuer;
    this.audience = config.audience;
    this.expiryHours = config.tokenExpiryHours;
  }

  async generateToken(payload: TokenPayload): Promise<string> {
    const { SignJWT } = await import('jose');
    return new SignJWT({
      tenant_id: payload.tenantId,
      user_id: payload.userId,
      role: payload.userRole,
      plan: payload.plan,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(`${this.expiryHours}h`)
      .setIssuer(this.issuer)
      .setAudience(this.audience)
      .sign(this.secret);
  }

  async verifyToken(token: string): Promise<TenantContext> {
    const { jwtVerify } = await import('jose');
    const { payload } = await jwtVerify(token, this.secret, {
      issuer: this.issuer,
      audience: this.audience,
    });

    const tenantId = payload.tenant_id;
    const userId = payload.user_id;
    const userRole = payload.role;
    const plan = payload.plan;

    if (typeof tenantId !== 'string' || typeof userId !== 'string') {
      throw new Error('Invalid token: missing tenant_id or user_id');
    }

    return {
      tenantId: tenantId as string,
      userId: userId as string,
      userRole: (userRole as UserRole) ?? 'viewer',
      plan: (plan as TenantPlan) ?? 'free',
    };
  }

  async generateApiKey(tenantId: string, userId: string): Promise<string> {
    const { SignJWT } = await import('jose');
    return new SignJWT({
      tenant_id: tenantId,
      user_id: userId,
      role: 'admin' as UserRole,
      plan: 'enterprise' as TenantPlan,
      type: 'api_key',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setIssuer(this.issuer)
      .setAudience(this.audience)
      .sign(this.secret);
  }
}

class NoopAuthService implements AuthService {
  private defaultContext: TenantContext = {
    tenantId: 'default',
    userId: 'default',
    userRole: 'owner',
    plan: 'enterprise',
  };

  async generateToken(): Promise<string> {
    return 'noop-token';
  }
  async verifyToken(): Promise<TenantContext> {
    return this.defaultContext;
  }
  async generateApiKey(): Promise<string> {
    return 'noop-api-key';
  }
}

export function createAuthService(config: EnterpriseConfig): AuthService {
  if (!config.auth.enabled) {
    return new NoopAuthService();
  }
  return new JoseAuthService(config.auth);
}
