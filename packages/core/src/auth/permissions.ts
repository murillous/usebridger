// Permissões `<área>.<ação>` e papéis fixos da API (ADR 0127). Plugins declaram as dos próprios
// recursos no M7-8; aqui só as do core.

export const CORE_PERMISSIONS = [
  'connection.read',
  'connection.manage',
  'logs.read',
  'plugins.read',
  'plugins.manage',
  'config.read',
  'config.write',
  'secrets.write',
  'metrics.read',
  'audit.read',
  'users.manage',
  'keys.manage',
  'auth.on-behalf-of',
] as const;

export const ROLES = ['owner', 'admin', 'viewer'] as const;
export type AuthRole = (typeof ROLES)[number];

export function isRole(value: unknown): value is AuthRole {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/** `owner` e `admin` têm tudo (o limite do admin está em `canManageRole`); `viewer`, só leitura. */
export function rolePermissions(role: AuthRole): readonly string[] {
  return role === 'viewer' ? CORE_PERMISSIONS.filter((p) => p.endsWith('.read')) : CORE_PERMISSIONS;
}

/** Quem pode criar, alterar, desativar ou dar papel a quem: o admin não toca em owner. */
export function canManageRole(actor: AuthRole, target: AuthRole): boolean {
  if (actor === 'owner') return true;
  return actor === 'admin' && target !== 'owner';
}
