// Ator autenticado da API (ADR 0127).

import type { AuthRole } from './permissions.ts';

export interface ApiActor {
  /** Id do usuário ou da API key. */
  readonly id: string;
  readonly kind: 'user' | 'key';
  readonly name: string;
  readonly permissions: readonly string[];
  /** Papel do usuário; a regra "admin não gerencia owner" (`canManageRole`) precisa dele. */
  readonly role?: AuthRole;
  /** Quem a chave representa (`X-Bridger-On-Behalf-Of`). */
  readonly onBehalfOf?: string;
}
