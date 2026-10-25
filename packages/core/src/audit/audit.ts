// Log de auditoria do kernel (ADR 0122): `record` síncrono que enfileira, dreno de um evento por
// vez numa cadeia de hash, `verify` e `query`. Um por bot: a cadeia é da sessão, e a trava do
// ADR 0070 garante o único escritor.

import { type ConfigEnv, processEnv, readSecretKeys } from '#config/env.ts';
import * as LOG from '#logger/events.ts';
import { deriveSubkey } from '#logger/pseudonym.ts';
import type { SecretSource } from '#logger/secrets.ts';
import type { Logger } from '#logger/types.ts';
import type { Observers } from '#observers/observers.ts';
import { DEFAULT_SESSION, kernelStorage, sessionStorage } from '#storage/namespace.ts';
import type { Collection, FieldCondition, JsonObject, StoragePort } from '#storage/types.ts';
import type { TenantScope } from '#tenant/scope.ts';
import { currentTrace } from '#trace/scope.ts';
import { canonical, chainHash, GENESIS_HASH, ulid } from './chain.ts';
import { createDetailsRedactor } from './details.ts';
import { currentAuditSubject } from './scope.ts';
import type {
  AuditActor,
  AuditEvent,
  AuditPage,
  AuditQuery,
  AuditRecordInput,
  AuditVerifyResult,
  InternalRecordInput,
  PluginAudit,
} from './types.ts';
import { strip, verifyChain } from './verify.ts';

export const AUDIT_COLLECTION = 'audit';
export const AUDIT_INDEXES = ['seq', 'at', 'actorId', 'targetId', 'tenant', 'action'] as const;
/** Fila em memória: passou disto, o evento novo é descartado. */
export const AUDIT_MAX_QUEUE = 10_000;
export const AUDIT_FLUSH_MS = 1000;
export const AUDIT_FLUSH_SIZE = 100;
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30_000;
const STOP_POLL_MS = 250;
const DEFAULT_QUERY_LIMIT = 100;
const MAX_QUERY_LIMIT = 1000;
// Rótulo próprio, como o do pseudônimo: a chave da cadeia não serve a outro uso.
const HKDF_INFO = 'bridger-audit-v1';
// Sem BRIDGER_SECRET_KEY a cadeia ainda detecta edição ingênua, mas quem tem o banco a recalcula.
const UNKEYED = Buffer.from('bridger-audit-unkeyed-v1');
const OUTCOMES: ReadonlySet<string> = new Set(['success', 'denied', 'error']);

/** Chave da cadeia, derivada da chave mestra (ADR 0119); sem ela, uma chave fixa e pública. */
export function auditKey(master: Buffer | undefined): Buffer {
  return master === undefined ? UNKEYED : deriveSubkey(master, HKDF_INFO);
}

export type AuditDropReason = 'queue-full' | 'lease-lost' | 'shutdown';

/** `query`/`verify` chamados por plugin que não está em `adminPlugins` (ADR 0107). */
export class AuditPermissionError extends Error {
  override readonly name: string = 'AuditPermissionError';

  constructor(plugin: string, operation: string) {
    super(`plugin "${plugin}": ctx.audit.${operation} exige o plugin em adminPlugins`);
  }
}

export interface AuditDeps {
  /** Coleção `audit` do namespace do kernel da sessão; lida só no primeiro uso. */
  readonly collection: () => Collection<JsonObject>;
  readonly session: string;
  readonly tenants: TenantScope;
  /** Lido a cada uso: o logger do bot nasce no `start()`. */
  readonly log: () => Logger;
  readonly observers: Observers;
  readonly secrets: SecretSource;
  /** Chave mestra (`BRIDGER_SECRET_KEY`), lida na primeira necessidade. */
  readonly masterKey: () => Buffer | undefined;
  /** Relógio do servidor; injetável nos testes. */
  readonly now?: () => Date;
}

/** O que o resto do core usa; o plugin só vê o `forPlugin`. */
export interface Audit {
  /**
   * Gravação interna do core (ações do kernel). Sem `actor`, vale o titular do escopo
   * (`user`/`contact`) e, sem ele, `system`. Plugin admin que age passa `{ kind: 'plugin', name }`.
   * Aceita qualquer `action`.
   */
  record(input: InternalRecordInput): void;
  forPlugin(plugin: string, admin: boolean): PluginAudit;
  query(filter?: AuditQuery): Promise<AuditPage>;
  verify(): Promise<AuditVerifyResult>;
  /** Começa a gravar: lê o topo da cadeia e liga o flush. Antes disso `record` só enfileira. */
  start(): void;
  /** Esvazia a fila até o `signal` abortar; o resto é descartado (`shutdown`). */
  stop(signal: AbortSignal): Promise<void>;
  /** A trava da sessão foi perdida: descarta a fila sem gravar e recusa o que vier. */
  leaseLost(): void;
  /** Descarta o que resta e recusa o que vier (shutdown abandonado). */
  close(): void;
  /** Uma passada do dreno agora (para o job de expurgação e os testes). */
  flush(): Promise<void>;
}

type Pending = Omit<AuditEvent, 'seq' | 'prevHash' | 'hash'>;

export function createAudit(deps: AuditDeps): Audit {
  const now = deps.now ?? (() => new Date());
  const redactDetails = createDetailsRedactor(deps.secrets);
  const queue: Pending[] = [];
  let collection: Collection<JsonObject> | undefined;
  const col = (): Collection<JsonObject> => (collection ??= deps.collection());
  let key: Buffer | undefined;
  const getKey = (): Buffer => (key ??= auditKey(deps.masterKey()));

  // Topo da cadeia gravado; só avança depois de um insert confirmado.
  let lastSeq = 0;
  let lastHash = GENESIS_HASH;
  let needReload = true;
  let started = false;
  let closedReason: AuditDropReason | undefined;
  let timer: NodeJS.Timeout | undefined;
  let retryMs = 0;
  let draining: Promise<void> | undefined;
  // Descartes antes de haver observador: saem no primeiro sinal depois do registro.
  let beforeObserver = 0;

  function drop(count: number, reason: AuditDropReason): void {
    deps.log().event(LOG.auditDropped, { count, reason });
    if (!deps.observers.has('audit.dropped')) {
      beforeObserver += count;
      return;
    }
    if (beforeObserver > 0) {
      deps.observers.emit('audit.dropped', { count: beforeObserver, reason: 'before-observer' });
      beforeObserver = 0;
    }
    deps.observers.emit('audit.dropped', { count, reason });
  }

  function discard(reason: AuditDropReason): void {
    closedReason ??= reason;
    clearTimeout(timer);
    timer = undefined;
    const count = queue.length;
    queue.length = 0;
    if (count > 0) drop(count, reason);
  }

  function schedule(ms: number): void {
    if (timer !== undefined || !started || closedReason !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void run();
    }, ms);
    timer.unref();
  }

  /** Relê o topo gravado. Um insert ambíguo (timeout) que entrou sai da fila aqui, sem duplicar. */
  async function reload(): Promise<void> {
    const [top] = await col().find({ orderBy: { field: 'seq', direction: 'desc' }, limit: 1 });
    lastSeq = typeof top?.['seq'] === 'number' ? top['seq'] : 0;
    lastHash = typeof top?.['hash'] === 'string' ? top['hash'] : GENESIS_HASH;
    if (top !== undefined && queue[0]?.eventId === top['eventId']) queue.shift();
  }

  async function drain(): Promise<void> {
    try {
      if (needReload) {
        await reload();
        needReload = false;
      }
      while (queue.length > 0 && closedReason === undefined) {
        const item = queue[0] as Pending;
        const body = { ...item, seq: lastSeq + 1, prevHash: lastHash };
        const hash = chainHash(getKey(), lastHash, body);
        // O round-trip pelo JSON canônico tira os `undefined` e garante o que o verify recalcula.
        const document = JSON.parse(canonical({ ...body, hash })) as JsonObject;
        await col().insert(document);
        lastSeq = body.seq;
        lastHash = hash;
        if (queue[0] === item) queue.shift();
      }
      retryMs = 0;
    } catch (error) {
      // Qualquer erro, inclusive timeout, é ambíguo: o topo é relido antes da próxima tentativa.
      needReload = true;
      retryMs = Math.min(retryMs === 0 ? RETRY_MIN_MS : retryMs * 2, RETRY_MAX_MS);
      deps.log().event(LOG.auditFlushFailed, { err: error, queued: queue.length, retryMs });
      schedule(retryMs);
    }
  }

  function run(): Promise<void> {
    draining ??= drain().finally(() => {
      draining = undefined;
    });
    return draining;
  }

  function build(
    input: AuditRecordInput,
    plugin: string | undefined,
    explicit?: AuditActor,
  ): Pending {
    const { action } = input;
    if (typeof action !== 'string' || action === '') {
      throw new TypeError('audit: action deve ser texto não vazio');
    }
    if (plugin !== undefined) {
      if (action.startsWith('kernel.') || action.startsWith('audit.')) {
        throw new TypeError(
          `plugin "${plugin}": action "${action}" usa prefixo reservado ao core (kernel., audit.)`,
        );
      }
      if (!action.startsWith(`${plugin}.`) || action.length === plugin.length + 1) {
        throw new TypeError(`plugin "${plugin}": action "${action}" deve começar com "${plugin}."`);
      }
    }
    const outcome = input.outcome ?? 'success';
    if (!OUTCOMES.has(outcome)) throw new TypeError(`audit: outcome inválido "${String(outcome)}"`);
    const details =
      input.details === undefined
        ? undefined
        : redactDetails(input.details, input.includeContent === true);
    const subject = currentAuditSubject();
    const actor: AuditActor =
      explicit ??
      subject?.actor ??
      (plugin === undefined ? { kind: 'system' } : { kind: 'plugin', name: plugin });
    const at = now();
    return {
      v: 1,
      eventId: ulid(at.getTime()),
      at: at.toISOString(),
      actor,
      via: subject !== undefined && explicit === undefined ? plugin : undefined,
      action,
      target: input.target && { type: input.target.type, id: input.target.id },
      outcome,
      ip: subject?.ip,
      userAgent: subject?.userAgent,
      tenant: deps.tenants.current,
      session: deps.session,
      trace: currentTrace(),
      details,
      actorId: actor.kind === 'system' ? 'system' : actor.kind === 'plugin' ? actor.name : actor.id,
      targetId: input.target?.id,
    };
  }

  function enqueue(pending: Pending): void {
    if (closedReason !== undefined) {
      drop(1, closedReason);
      return;
    }
    if (queue.length >= AUDIT_MAX_QUEUE) {
      drop(1, 'queue-full');
      return;
    }
    queue.push(pending);
    if (!started) return;
    // Em retry o flush de 100 não passa por cima da espera: não martela um storage fora do ar.
    if (queue.length >= AUDIT_FLUSH_SIZE && retryMs === 0) void run();
    else schedule(AUDIT_FLUSH_MS);
  }

  async function query(filter: AuditQuery = {}): Promise<AuditPage> {
    const where: Record<string, FieldCondition> = {};
    if (filter.after !== undefined) where['seq'] = { gt: filter.after };
    if (filter.from !== undefined || filter.to !== undefined) {
      where['at'] = {
        ...(filter.from !== undefined && { gte: filter.from }),
        ...(filter.to !== undefined && { lte: filter.to }),
      };
    }
    if (filter.actor !== undefined) where['actorId'] = filter.actor;
    if (filter.action !== undefined) where['action'] = filter.action;
    if (filter.target !== undefined) where['targetId'] = filter.target;
    if (filter.outcome !== undefined) where['outcome'] = filter.outcome;
    // No request de um tenant o filtro é do escopo, nunca de quem consulta.
    const tenant = deps.tenants.current ?? filter.tenant;
    if (tenant !== undefined) where['tenant'] = tenant;
    const limit = Math.min(
      Math.max(Math.trunc(filter.limit ?? DEFAULT_QUERY_LIMIT), 1),
      MAX_QUERY_LIMIT,
    );
    const rows = await col().find({ where, orderBy: 'seq', limit });
    const events = rows.map(strip);
    const last = events.at(-1);
    return last === undefined ? { events } : { events, next: last.seq };
  }

  const verify = (): Promise<AuditVerifyResult> => verifyChain(col(), getKey());

  return {
    record: (input) => enqueue(build(input, undefined, input.actor)),
    forPlugin: (plugin, admin) => ({
      // Só os campos conhecidos: o plugin não injeta `actor` nem nada além do contrato.
      record: ({ action, target, outcome, details, includeContent }) =>
        enqueue(build({ action, target, outcome, details, includeContent }, plugin)),
      query: (filter) =>
        admin ? query(filter) : Promise.reject(new AuditPermissionError(plugin, 'query')),
      verify: () => (admin ? verify() : Promise.reject(new AuditPermissionError(plugin, 'verify'))),
    }),
    query,
    verify,
    start() {
      started = true;
      void run();
    },
    async stop(signal) {
      clearTimeout(timer);
      timer = undefined;
      while (queue.length > 0 && !signal.aborted && closedReason === undefined) {
        await run();
        if (queue.length > 0 && !signal.aborted) await pause(STOP_POLL_MS, signal);
      }
      discard('shutdown');
    },
    leaseLost() {
      discard('lease-lost');
    },
    close() {
      discard('shutdown');
    },
    flush: run,
  };
}

/** Espera `ms` ou até o `signal` abortar; nunca rejeita. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(wait);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const wait = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

export interface VerifyAuditOptions {
  readonly storage: StoragePort;
  /** Sessão da cadeia; padrão `default`. */
  readonly session?: string;
  /** Ambiente de onde sai a `BRIDGER_SECRET_KEY`; padrão `process.env`. */
  readonly env?: ConfigEnv;
}

/**
 * Verifica a cadeia de uma sessão sem subir o bot: para o script do app (ADR 0122), que cria o
 * `StoragePort` e chama isto. Lança o que o storage lançar e `BotConfigError` com chave malformada.
 */
export function verifyAudit(options: VerifyAuditOptions): Promise<AuditVerifyResult> {
  const scoped = sessionStorage(options.storage, options.session ?? DEFAULT_SESSION);
  const collection = kernelStorage(scoped, AUDIT_COLLECTION).collection<JsonObject>(
    AUDIT_COLLECTION,
    { indexes: AUDIT_INDEXES },
  );
  return verifyChain(collection, auditKey(readSecretKeys(options.env ?? processEnv()).current));
}
