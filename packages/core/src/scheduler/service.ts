// Scheduler do bot (M1-11, plano §6.8). Um serviço por bot: os jobs de todos os plugins ficam
// numa única coleção do namespace do kernel (`$scheduler`), e um único timer fica armado para o
// próximo horário. Nada de polling: sem job futuro, nenhum timer existe.
//
// Entrega "pelo menos uma vez": o documento só sai do storage depois que o handler termina.
// Se o processo cair no meio, o job continua lá e dispara de novo ao subir.
// Série (`every`) não sai do storage: só avança o `fireAt` depois do handler.

import { AsyncLocalStorage } from 'node:async_hooks';
import { ContextExpiredError, Deadline, JobTimeoutError } from '#deadline.ts';
import type { PluginErrorEvent } from '#events/types.ts';
import * as LOG from '#logger/events.ts';
import { NO_TRAIL, type Trail } from '#logger/trail.ts';
import { kernelStorage } from '#storage/namespace.ts';
import type { Collection, JsonValue, StoragePort, Where, WithId } from '#storage/types.ts';
import { TenantScope } from '#tenant/scope.ts';
import { currentTrace, newTraceId, outsideTrace, runInTrace } from '#trace/scope.ts';
import type { Unsubscribe } from '#transport/types.ts';
import { nextOccurrence, normalizeRule, type RecurrenceRule } from './rule.ts';
import type { JobContext, JobHandler, Scheduler } from './types.ts';

export const DEFAULT_JOB_TIMEOUT_MS = 30_000;
export const DEFAULT_STORAGE_RETRY_MS = 5000;
export const DEFAULT_MAX_CONCURRENT_JOBS = 10;

/** Vencidos lidos por consulta: a leitura é paginada, nunca a coleção inteira na memória. */
const DUE_PAGE_SIZE = 100;

/**
 * Maior atraso que o `setTimeout` aceita (~24,8 dias). Acima disso o Node dispara em 1 ms; job
 * mais distante arma o teto e, ao acordar, o loop só recalcula e rearma.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Documento de um agendamento. `type` (não `interface`) para casar com o JSON da coleção. */
type JobDocument = {
  plugin: string;
  job: string;
  /** Epoch ms. Indexado: é por ele que o loop consulta. */
  fireAt: number;
  payload: JsonValue;
  /** Tenant de quem agendou (ADR 0068); o handler roda no escopo dele. Ausente: sem tenant. */
  tenant?: string;
  /** Presente só em série (`every`): o documento é a série e `fireAt` a ocorrência pendente. */
  rule?: RecurrenceRule;
  /** Trace de quem agendou (ADR 0120): vira o `cause` do `job.run`. Ausente: fora de um trace. */
  cause?: string;
};

type StoredJob = WithId<JobDocument>;

interface RegisteredHandler {
  readonly handler: JobHandler;
  /** `Deadline` de vida do plugin: pai do `Deadline` de cada execução do handler. */
  readonly lifetime: Deadline | undefined;
}

export interface SchedulerServiceOptions {
  /** Storage do bot; os jobs ficam em `kernelStorage(storage, 'scheduler')`. */
  readonly storage: StoragePort;
  /**
   * Destino de toda falha de handler (lançou, rejeitou ou estourou o prazo), com
   * `phase: 'scheduler'` e o nome do job em `event`. Não deve lançar.
   */
  readonly onError: (error: PluginErrorEvent) => void;
  /**
   * Destino da rejeição de um handler que chegou depois do prazo, já reportado como timeout
   * pelo `onError`: normalmente só o log, para não virar um segundo `plugin.error`. Padrão:
   * `onError`. Não deve lançar.
   */
  readonly onLateError?: (error: PluginErrorEvent) => void;
  /**
   * Destino das falhas do próprio storage (consulta do loop, remoção depois do handler). O loop
   * não morre: tenta de novo após `storageRetryMs`. Não deve lançar.
   */
  readonly onStorageError: (error: unknown) => void;
  /**
   * Escopo de tenant do bot (ADR 0068): `at` guarda o tenant corrente no job, e o handler roda
   * no escopo dele. Padrão: um escopo próprio, sem tenant.
   */
  readonly tenants?: TenantScope;
  /** Trilha de eventos: uma linha `job.run` por execução. Padrão: desligada. */
  readonly trail?: Trail;
  /** Prazo de cada handler em ms. Padrão: 30000. */
  readonly jobTimeoutMs?: number;
  /** Espera antes de reconsultar o storage depois de uma falha, em ms. Padrão: 5000. */
  readonly storageRetryMs?: number;
  /**
   * Máximo de handlers rodando ao mesmo tempo, somando todos os plugins. Os vencidos além dele
   * esperam vaga, em ordem de `fireAt` (depois de um downtime longo, nada de milhares de handlers
   * de uma vez). Padrão: 10.
   */
  readonly maxConcurrentJobs?: number;
}

export interface SchedulerService {
  /**
   * Scheduler em nome do plugin (`ctx.scheduler`): jobs e handlers no namespace dele. Com
   * `lifetime` (o `Deadline` de vida do plugin), o descarte do plugin aborta o `signal` dos jobs
   * dele ainda em andamento.
   */
  forPlugin(plugin: string, lifetime?: Deadline): Scheduler;
  /**
   * Remove os handlers do plugin (teardown e reload). Os jobs persistidos ficam: disparam
   * quando o plugin registrar o handler de novo.
   */
  removePlugin(plugin: string): void;
  /** Liga o loop: dispara o que venceu (inclusive durante o downtime) e arma o próximo. */
  start(): void;
  /**
   * Desarma o timer e espera os handlers em andamento (cada um limitado pelo prazo de job).
   * Abortado o `signal`, abandona os que ainda rodam: o `signal` do job aborta, o prazo dele é
   * desarmado e o documento fica no storage, para disparar de novo na próxima subida. Depois
   * dele não sobra timer vivo. Idempotente.
   */
  stop(signal?: AbortSignal): Promise<void>;
}

/** Dois handlers para o mesmo job do mesmo plugin: o job seria consumido por um só. */
export class JobHandlerConflictError extends Error {
  override readonly name = 'JobHandlerConflictError';
  readonly plugin: string;
  readonly job: string;

  constructor(plugin: string, job: string) {
    super(
      `O plugin "${plugin}" já registrou um handler para o job "${job}". Cada job tem um ` +
        'handler; cancele o anterior (a função devolvida por on) antes de registrar outro.',
    );
    this.plugin = plugin;
    this.job = job;
  }
}

function validTimeout(name: string, value: number): number {
  // setTimeout trata Infinity/NaN como 1 ms: tudo estouraria na hora.
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} inválido: ${value}`);
  return value;
}

function toEpoch(when: Date | number): number {
  const ms = when instanceof Date ? when.getTime() : when;
  if (typeof ms !== 'number' || !Number.isFinite(ms)) {
    throw new TypeError(`Horário inválido para o job: ${String(when)}. Use Date ou epoch ms.`);
  }
  return ms;
}

function assertJobName(job: unknown): asserts job is string {
  if (typeof job !== 'string' || job === '') {
    throw new TypeError('Nome de job deve ser texto não vazio.');
  }
}

/**
 * Recusa o que o JSON perderia ou alteraria em silêncio (`undefined`, `NaN`, `Date`, `Map`,
 * classes, ciclos): o handler tem de receber exatamente o payload agendado.
 */
function assertJsonValue(value: unknown, path: string, seen: Set<object>): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return;
    throw new TypeError(`Payload inválido em ${path}: ${value} não é JSON.`);
  }
  if (typeof value !== 'object') {
    throw new TypeError(`Payload inválido em ${path}: ${typeof value} não é JSON.`);
  }
  if (seen.has(value)) throw new TypeError(`Payload inválido em ${path}: referência circular.`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      assertJsonValue(item, `${path}[${i}]`, seen);
    });
  } else {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError(`Payload inválido em ${path}: só objetos simples são JSON.`);
    }
    for (const [key, item] of Object.entries(value)) assertJsonValue(item, `${path}.${key}`, seen);
  }
  seen.delete(value);
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as PromiseLike<unknown>).then === 'function'
  );
}

export function createSchedulerService(options: SchedulerServiceOptions): SchedulerService {
  const { onError, onStorageError } = options;
  const onLateError = options.onLateError ?? onError;
  const tenants = options.tenants ?? new TenantScope();
  const trail = options.trail ?? NO_TRAIL;
  const jobTimeoutMs = validTimeout('jobTimeoutMs', options.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS);
  const retryMs = validTimeout(
    'storageRetryMs',
    options.storageRetryMs ?? DEFAULT_STORAGE_RETRY_MS,
  );
  const maxConcurrent = options.maxConcurrentJobs ?? DEFAULT_MAX_CONCURRENT_JOBS;
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new RangeError(`maxConcurrentJobs inválido: ${maxConcurrent}`);
  }
  const jobs: Collection<JobDocument> = kernelStorage(options.storage, 'scheduler').collection(
    'jobs',
    { indexes: ['fireAt'] },
  );

  // plugin → job → handler (com o `Deadline` de vida do plugin que o registrou).
  const handlers = new Map<string, Map<string, RegisteredHandler>>();
  // id → handler em andamento (resolve quando o job saiu do storage). Impede entrega dupla
  // enquanto o handler roda e responde ao `cancel` de job já disparado.
  const inFlight = new Map<string, Promise<void>>();
  // ids de série com handler em andamento: o `cancel` deles apaga o documento (job `at` não).
  const seriesInFlight = new Set<string>();
  // id → abandono do handler em andamento, usado pelo `stop` abortado.
  const abandons = new Map<string, (reason: unknown) => void>();

  // Contexto assíncrono de quem criou o serviço. O loop roda nele, e não no de quem o acordou: um
  // `schedule` feito dentro de um observador de `log` (ADR 0105) não pode emprestar o silêncio
  // aos handlers de outros plugins (#163).
  const detached = AsyncLocalStorage.snapshot();
  let started = false;
  let timer: NodeJS.Timeout | undefined;
  let armedAt: number | undefined;
  // Volta do loop em andamento; `rerun` pede outra volta quando algo mudou durante a atual.
  let loop: Promise<void> | undefined;
  let rerun = false;
  // A última volta parou por falta de vaga: quando um handler termina, o loop roda de novo.
  let backlog = false;
  // Uma remoção falhou: a volta nesse horário reentrega o job (pelo menos uma vez).
  let retryAt: number | undefined;

  // Exclusão mútua entre "ler os vencidos e despachar" e `cancel`: sem ela, um `cancel` poderia
  // apagar o job depois da leitura e antes do despacho, devolver `true` e o job disparar mesmo
  // assim.
  let lock: Promise<unknown> = Promise.resolve();
  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = lock.then(fn);
    lock = result.catch(() => undefined);
    return result;
  }

  function disarm(): void {
    clearTimeout(timer);
    timer = undefined;
    armedAt = undefined;
  }

  function arm(at: number): void {
    disarm();
    const delay = Math.min(Math.max(at - Date.now(), 0), MAX_TIMER_DELAY_MS);
    armedAt = at;
    // Fora do trace de quem agendou: o timer vive além da mensagem e o que ele logar não é dela.
    timer = outsideTrace(() =>
      setTimeout(() => {
        timer = undefined;
        armedAt = undefined;
        wake();
      }, delay),
    );
  }

  /** Garante que o loop acorde a tempo de `fireAt` (job novo ou próxima ocorrência de série). */
  function scheduleWake(fireAt: number): void {
    if (!started) return;
    if (loop !== undefined) rerun = true;
    else if (armedAt === undefined || fireAt < armedAt) arm(fireAt);
  }

  /** Pede uma volta do loop; se já há uma rodando, ela repete ao terminar. */
  function wake(): void {
    if (!started) return;
    if (loop !== undefined) {
      rerun = true;
      return;
    }
    disarm();
    loop = outsideTrace(() =>
      detached(async () => {
        do {
          rerun = false;
          await tick();
        } while (rerun && started);
      }),
    ).finally(() => {
      loop = undefined;
      // Um `rerun` pedido depois do `while` e antes daqui não teria volta nem timer (#142).
      if (rerun) wake();
    });
  }

  /**
   * Filtro dos jobs que têm handler, ou `undefined` sem nenhum. Sem ele, os órfãos (plugin
   * desligado, job renomeado) seriam relidos do storage a cada volta, e o custo de cada disparo
   * cresceria com o lixo acumulado (#228). Como `Where` só combina campos com E, o filtro é o
   * produto `plugin × job`: um órfão só passa se outro plugin tiver handler com o mesmo nome de
   * job, e o `dispatch` o pula.
   */
  function withHandler(): Where<JobDocument> | undefined {
    if (handlers.size === 0) return undefined;
    const names = new Set<string>();
    for (const byJob of handlers.values()) for (const job of byJob.keys()) names.add(job);
    return { plugin: { in: [...handlers.keys()] }, job: { in: [...names] } };
  }

  async function tick(): Promise<void> {
    const now = Date.now();
    // Esta volta já reentrega o que a remoção não tirou do storage.
    retryAt = undefined;
    let next: number | undefined;
    try {
      await exclusive(() => dispatchDue(now));
      // Job sem handler não arma timer: espera o `on` do plugin, que acorda o loop.
      const filter = withHandler();
      const [upcoming] =
        filter === undefined
          ? []
          : await jobs.find({
              where: { ...filter, fireAt: { gt: now } },
              orderBy: 'fireAt',
              limit: 1,
            });
      next = upcoming?.fireAt;
    } catch (error) {
      onStorageError(error);
      next = Date.now() + retryMs;
    }
    if (retryAt !== undefined && (next === undefined || retryAt < next)) next = retryAt;
    if (started && !rerun && next !== undefined) arm(next);
  }

  /**
   * Despacha os vencidos com handler em ordem de `fireAt` até acabarem as vagas, lendo uma
   * página por vez. Os que estão em andamento não ocupam vaga e são pulados pelo `offset`, para
   * não travarem os de trás (no máximo `maxConcurrent` deles). Se um handler terminar no meio da varredura e o `offset` pular um
   * vencido, a volta extra que esse término pede (`wake`) o encontra.
   */
  async function dispatchDue(now: number): Promise<void> {
    backlog = false;
    const filter = withHandler();
    if (filter === undefined) return;
    for (let offset = 0; started; offset += DUE_PAGE_SIZE) {
      const page = await jobs.find({
        where: { ...filter, fireAt: { lte: now } },
        orderBy: 'fireAt',
        limit: DUE_PAGE_SIZE,
        offset,
      });
      for (const doc of page) {
        if (!started) return;
        if (inFlight.size >= maxConcurrent) {
          backlog = true;
          return;
        }
        dispatch(doc);
      }
      if (page.length < DUE_PAGE_SIZE) return;
    }
  }

  function dispatch(doc: StoredJob): void {
    if (inFlight.has(doc.id)) return;
    const registered = handlers.get(doc.plugin)?.get(doc.job);
    // Órfão que passou pelo filtro (ver `withHandler`): fica pendente no storage.
    if (registered === undefined) return;
    const done = run(doc, registered)
      // Abandonado no shutdown, o job não terminou: fica no storage para a próxima subida.
      .then(async (finished) => {
        if (!finished) return finished;
        if (doc.rule === undefined) {
          await jobs.delete(doc.id);
          return finished;
        }
        // Série: avança a ocorrência a partir de agora. Se foi cancelada durante o handler, o
        // update casa 0 e ela não renasce.
        let fireAt: number;
        try {
          fireAt = nextOccurrence(doc.rule, doc.fireAt, Date.now());
        } catch (error) {
          // Regra que não dá mais para calcular (fuso que o ICU perdeu, formato desconhecido):
          // reentregar a mesma ocorrência para sempre seria pior que encerrar a série.
          fail(doc, error, false);
          await jobs.delete(doc.id);
          return finished;
        }
        if ((await jobs.update(doc.id, { fireAt })) > 0) scheduleWake(fireAt);
        return finished;
      })
      .then(
        (removed) => removed,
        (error: unknown) => {
          onStorageError(error);
          // O job ficou no storage: uma volta depois do retry o entrega de novo, mesmo sem outro
          // evento que acorde o loop. Uma volta em curso também respeita `retryAt` ao rearmar.
          const at = Date.now() + retryMs;
          retryAt = Math.min(retryAt ?? at, at);
          if (started && (armedAt === undefined || at < armedAt)) arm(at);
          return false;
        },
      )
      .then((removed) => {
        inFlight.delete(doc.id);
        seriesInFlight.delete(doc.id);
        // Vaga liberada com vencidos esperando, ou varredura em curso que pode ter pulado um
        // (o `offset` anda, e a remoção puxou a fila uma posição).
        if (removed && (backlog || loop !== undefined)) wake();
      });
    inFlight.set(doc.id, done);
    if (doc.rule !== undefined) seriesInFlight.add(doc.id);
  }

  function fail(doc: StoredJob, error: unknown, timedOut: boolean): void {
    onError({ plugin: doc.plugin, phase: 'scheduler', event: doc.job, error, timedOut });
  }

  /**
   * Roda o handler contra o prazo e resolve `false` só se ele foi abandonado no `stop`. Nunca
   * rejeita: toda falha já foi entregue ao `onError`. Estourado o prazo (ou abandonado), o
   * `signal` do job aborta (ADR 0029).
   */
  function run(doc: StoredJob, registered: RegisteredHandler): Promise<boolean> {
    // Trace próprio por execução; o do agendamento fica no `cause`.
    return runInTrace(newTraceId(), () => runTraced(doc, registered));
  }

  function runTraced(doc: StoredJob, { handler, lifetime }: RegisteredHandler): Promise<boolean> {
    const startedAt = performance.now();
    const ended = (status: 'ok' | 'failed' | 'timeout'): void =>
      trail.emit(LOG.jobRun, {
        job: doc.job,
        plugin: doc.plugin,
        status,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        ...(doc.cause !== undefined && { cause: doc.cause }),
      });
    const deadline = new Deadline(lifetime);
    const job: JobContext = {
      scheduledAt: new Date(doc.fireAt),
      ...(doc.rule !== undefined && { seriesId: doc.id }),
      get signal(): AbortSignal {
        return deadline.signal;
      },
    };
    let result: unknown;
    try {
      // O job sem tenant sai de qualquer escopo: o loop pode ter sido acordado no handler de um.
      result = tenants.run(doc.tenant, () => handler(doc.payload, job));
    } catch (error) {
      fail(doc, error, false);
      ended('failed');
      return Promise.resolve(true);
    }
    if (!isThenable(result)) {
      ended('ok');
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (finished: boolean): void => {
        settled = true;
        clearTimeout(timeout);
        abandons.delete(doc.id);
        resolve(finished);
      };
      const timeout = setTimeout(() => {
        const error = new JobTimeoutError(doc.plugin, doc.job, jobTimeoutMs);
        settle(true);
        deadline.expire(error);
        fail(doc, error, true);
        ended('timeout');
      }, jobTimeoutMs);
      abandons.set(doc.id, (reason) => {
        settle(false);
        deadline.expire(reason);
      });
      result.then(
        () => {
          if (settled) return;
          settle(true);
          ended('ok');
        },
        (error: unknown) => {
          if (!settled) {
            settle(true);
            fail(doc, error, false);
            ended('failed');
            return;
          }
          // Rejeição depois do prazo: já reportado como timeout; o erro tardio vai só ao
          // `onLateError`. A recusa de um contexto expirado já foi logada (ADR 0029).
          if (error instanceof ContextExpiredError) return;
          onLateError({
            plugin: doc.plugin,
            phase: 'scheduler',
            event: doc.job,
            error,
            timedOut: false,
          });
        },
      );
    });
  }

  function forPlugin(plugin: string, lifetime?: Deadline): Scheduler {
    return {
      async at(when, job, payload = null) {
        const fireAt = toEpoch(when);
        assertJobName(job);
        assertJsonValue(payload, 'payload', new Set());
        const tenant = tenants.current;
        const cause = currentTrace();
        const id = await jobs.insert({
          plugin,
          job,
          fireAt,
          payload,
          ...(tenant !== undefined && { tenant }),
          ...(cause !== undefined && { cause }),
        });
        scheduleWake(fireAt);
        return id;
      },

      async every(rule, job, payload = null) {
        const normalized = normalizeRule(rule);
        assertJobName(job);
        assertJsonValue(payload, 'payload', new Set());
        const tenant = tenants.current;
        const cause = currentTrace();
        const now = Date.now();
        const fireAt = nextOccurrence(normalized, now, now);
        const id = await jobs.insert({
          plugin,
          job,
          fireAt,
          payload,
          rule: normalized,
          ...(tenant !== undefined && { tenant }),
          ...(cause !== undefined && { cause }),
        });
        scheduleWake(fireAt);
        return id;
      },

      async next(id) {
        const [doc] = await jobs.find({ where: { id, plugin }, limit: 1 });
        if (doc === undefined) return undefined;
        if (doc.rule === undefined) return inFlight.has(id) ? undefined : new Date(doc.fireAt);
        // Handler rodando e `fireAt` ainda na ocorrência que disparou: a próxima vem da regra.
        // Se o `update` já avançou (janela até o `inFlight.delete`), o `fireAt` já é a próxima.
        if (inFlight.has(id) && doc.fireAt <= Date.now()) {
          return new Date(nextOccurrence(doc.rule, doc.fireAt, Date.now()));
        }
        return new Date(doc.fireAt);
      },

      cancel(id) {
        return exclusive(async () => {
          // Série em andamento: apaga o documento, e o fim do handler não a faz renascer. Job `at`
          // já disparou: sai do storage quando o handler terminar.
          if (inFlight.has(id) && !seriesInFlight.has(id)) return false;
          return (await jobs.delete({ id, plugin })) > 0;
        });
      },

      on(job, handler): Unsubscribe {
        assertJobName(job);
        if (typeof handler !== 'function') throw new TypeError(`Handler de "${job}" não é função`);
        let byJob = handlers.get(plugin);
        if (byJob === undefined) {
          byJob = new Map();
          handlers.set(plugin, byJob);
        }
        if (byJob.has(job)) throw new JobHandlerConflictError(plugin, job);
        const registered: RegisteredHandler = { handler, lifetime };
        byJob.set(job, registered);
        // Pode haver jobs vencidos esperando por este handler.
        wake();
        return () => {
          const current = handlers.get(plugin);
          if (current?.get(job) !== registered) return;
          current.delete(job);
          if (current.size === 0) handlers.delete(plugin);
        };
      },
    };
  }

  return {
    forPlugin,

    removePlugin(plugin) {
      handlers.delete(plugin);
    },

    start() {
      if (started) return;
      started = true;
      wake();
    },

    async stop(signal) {
      started = false;
      disarm();
      const abandon = (): void => {
        for (const fn of abandons.values()) fn(signal?.reason);
      };
      if (signal?.aborted) abandon();
      else signal?.addEventListener('abort', abandon, { once: true });
      await loop;
      // Um `at` pode ter rearmado enquanto o loop terminava; nada pode sobrar vivo.
      disarm();
      await Promise.all(inFlight.values());
    },
  };
}
