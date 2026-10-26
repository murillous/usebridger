// Tipos do log de auditoria (ADR 0122).

import type { JsonValue } from '#storage/types.ts';

export type AuditActor =
  | { readonly kind: 'user'; readonly id: string; readonly name: string }
  | { readonly kind: 'system' }
  | { readonly kind: 'plugin'; readonly name: string }
  | { readonly kind: 'contact'; readonly transport: string; readonly id: string };

export type AuditOutcome = 'success' | 'denied' | 'error';

export interface AuditEvent {
  /** Versão do formato (e do JSON canônico) que entra no hash. */
  readonly v: 1;
  /** Ulid só para referência humana; não é o `id` do storage. */
  readonly eventId: string;
  /** Posição na cadeia da sessão; chave da cadeia e do cursor. */
  readonly seq: number;
  /** ISO 8601 UTC, relógio do servidor. */
  readonly at: string;
  readonly actor: AuditActor;
  /** Plugin por cuja rota o request de `user`/`contact` chegou. */
  readonly via?: string;
  readonly action: string;
  readonly target?: { readonly type: string; readonly id: string };
  readonly outcome: AuditOutcome;
  readonly ip?: string;
  readonly userAgent?: string;
  readonly tenant?: string;
  readonly session: string;
  readonly trace?: string;
  readonly details?: { readonly [key: string]: JsonValue };
  /** Achatados de `actor`/`target` para o índice (campos de primeiro nível). */
  readonly actorId: string;
  readonly targetId?: string;
  readonly prevHash: string;
  readonly hash: string;
}

export interface AuditRecordInput {
  /** `<plugin>.<recurso>.<verbo>`; o prefixo é o nome do plugin. `kernel.` e `audit.` são do core. */
  readonly action: string;
  readonly target?: { readonly type: string; readonly id: string };
  /** Padrão `success`. */
  readonly outcome?: AuditOutcome;
  /** Redigido pelo core; a chave `content` é removida salvo `includeContent`. */
  readonly details?: { readonly [key: string]: unknown };
  readonly includeContent?: boolean;
}

export interface AuditQuery {
  /** Início e fim (inclusivos) por `at`, ISO 8601 UTC. */
  readonly from?: string;
  readonly to?: string;
  /** Id do ator (`actorId`). */
  readonly actor?: string;
  readonly action?: string;
  /** Id do alvo (`targetId`). */
  readonly target?: string;
  readonly outcome?: AuditOutcome;
  /** Ignorado dentro de um request de tenant: o core impõe o do escopo. */
  readonly tenant?: string;
  /** Devolve só eventos com `seq` maior que isto. */
  readonly after?: number;
  /** Padrão 100, máximo 1000. */
  readonly limit?: number;
}

export interface AuditPage {
  readonly events: readonly AuditEvent[];
  /** `seq` do último evento, cursor da próxima página; ausente com a página vazia. */
  readonly next?: number;
}

export interface AuditVerifyResult {
  readonly ok: boolean;
  readonly checked: number;
  readonly brokenAt?: { readonly seq: number; readonly eventId: string; readonly reason: string };
}

/** `ctx.audit` do plugin. `query` e `verify` exigem `adminPlugins` (ADR 0107). */
export interface PluginAudit {
  /** Síncrono e nunca aguardado: enfileira. Lança `TypeError` com `action` ou `details` inválidos. */
  record(input: AuditRecordInput): void;
  query(filter?: AuditQuery): Promise<AuditPage>;
  verify(): Promise<AuditVerifyResult>;
}

/** Titular de um request ou fluxo LGPD, lido do `AsyncLocalStorage` (ver `scope.ts`). */
export interface AuditSubject {
  readonly actor: Extract<AuditActor, { kind: 'user' | 'contact' }>;
  readonly ip?: string;
  readonly userAgent?: string;
}

/** Entrada da gravação interna do core: o ator padrão é o do escopo, senão `system`. */
export interface InternalRecordInput extends AuditRecordInput {
  readonly actor?: AuditActor;
  /** Endereço de quem agiu quando não há titular no escopo (ex.: login que falhou). */
  readonly ip?: string;
}
