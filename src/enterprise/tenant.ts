// ── Multi-Tenancy Core Types & Context ────────────────────────────────────

export type TenantPlan = 'free' | 'pro' | 'enterprise';

export type UserRole = 'owner' | 'admin' | 'editor' | 'viewer';

export interface Tenant {
  id: string;
  name: string;
  plan: TenantPlan;
  storageLimit: number; // bytes
  memoryLimit: number;  // max memories
  createdAt: string;
  suspendedAt: string | null;
}

export interface TenantUser {
  id: string;
  tenantId: string;
  email: string;
  name: string;
  role: UserRole;
  createdAt: string;
}

export interface TenantContext {
  tenantId: string;
  userId: string;
  userRole: UserRole;
  plan: TenantPlan;
}

export interface Permission {
  action: 'read' | 'write' | 'delete' | 'admin';
  resource: 'memories' | 'vault' | 'settings' | 'users';
}

const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  owner: [
    { action: 'read', resource: 'memories' },
    { action: 'write', resource: 'memories' },
    { action: 'delete', resource: 'memories' },
    { action: 'admin', resource: 'memories' },
    { action: 'read', resource: 'vault' },
    { action: 'write', resource: 'vault' },
    { action: 'delete', resource: 'vault' },
    { action: 'admin', resource: 'settings' },
    { action: 'admin', resource: 'users' },
  ],
  admin: [
    { action: 'read', resource: 'memories' },
    { action: 'write', resource: 'memories' },
    { action: 'delete', resource: 'memories' },
    { action: 'read', resource: 'vault' },
    { action: 'write', resource: 'vault' },
    { action: 'delete', resource: 'vault' },
    { action: 'admin', resource: 'settings' },
    { action: 'admin', resource: 'users' },
  ],
  editor: [
    { action: 'read', resource: 'memories' },
    { action: 'write', resource: 'memories' },
    { action: 'read', resource: 'vault' },
    { action: 'write', resource: 'vault' },
  ],
  viewer: [
    { action: 'read', resource: 'memories' },
    { action: 'read', resource: 'vault' },
  ],
};

export function hasPermission(
  role: UserRole,
  action: Permission['action'],
  resource: Permission['resource'],
): boolean {
  const perms = ROLE_PERMISSIONS[role];
  return perms.some(p => p.action === action && p.resource === resource);
}

export function requirePermission(
  ctx: TenantContext,
  action: Permission['action'],
  resource: Permission['resource'],
): void {
  if (!hasPermission(ctx.userRole, action, resource)) {
    const error = new Error(`Forbidden: ${ctx.userRole} cannot ${action} ${resource}`);
    (error as any).statusCode = 403;
    throw error;
  }
}
