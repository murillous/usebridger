// Permissões `<área>.<ação>` e papéis fixos da API (ADR 0127). As de plugin vêm das operações e
// dos recursos que ele registra (ADR 0134) e entram nos papéis pelo `extra`.

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
  'pseudonyms.resolve',
  'users.manage',
  'keys.manage',
  'auth.on-behalf-of',
] as const;

export const ROLES = ['owner', 'admin', 'viewer'] as const;
export type AuthRole = (typeof ROLES)[number];

export function isRole(value: unknown): value is AuthRole {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

const PERMISSION_FORMAT = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/;

/** Formato `<área>.<ação>` (ex.: `logs.read`, `rank.reset`). */
export function isPermission(value: unknown): value is string {
  return typeof value === 'string' && PERMISSION_FORMAT.test(value);
}

/**
 * `owner` e `admin` têm tudo (o limite do admin está em `canManageRole`); `viewer`, só leitura.
 * `extra` são as permissões declaradas pelos plugins carregados, que seguem a mesma regra.
 */
export function rolePermissions(role: AuthRole, extra: readonly string[] = []): readonly string[] {
  const all = extra.length === 0 ? CORE_PERMISSIONS : [...new Set([...CORE_PERMISSIONS, ...extra])];
  return role === 'viewer' ? all.filter((p) => p.endsWith('.read')) : all;
}

/** Quem pode criar, alterar, desativar ou dar papel a quem: o admin não toca em owner. */
export function canManageRole(actor: AuthRole, target: AuthRole): boolean {
  if (actor === 'owner') return true;
  return actor === 'admin' && target !== 'owner';
}
