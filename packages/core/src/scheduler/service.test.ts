import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextExpiredError } from '#deadline.ts';
import type { PluginErrorEvent } from '#events/types.ts';
import { createMemoryStorage } from '#storage/memory.ts';
import { kernelStorage } from '#storage/namespace.ts';
import type { Collection, JsonValue, StoragePort } from '#storage/types.ts';
import {
  createSchedulerService,
  JobHandlerConflictError,
  type SchedulerService,
  type SchedulerServiceOptions,
} from './service.ts';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 1);

let port: StoragePort;
let errors: PluginErrorEvent[];
let storageErrors: unknown[];
let services: SchedulerService[];

function create(overrides: Partial<SchedulerServiceOptions> = {}): SchedulerService {
  const service = createSchedulerService({
    storage: port,
    onError: (e) => errors.push(e),
    onStorageError: (e) => storageErrors.push(e),
    jobTimeoutMs: 1000,
    ...overrides,
  });
  services.push(service);
  return service;
}

/** Deixa promises e timers vencidos assentarem sem avançar o relógio. */
const settle = (): Promise<void> => vi.advanceTimersByTimeAsync(0).then(() => undefined);

function storedJobs(): Promise<unknown[]> {
  return kernelStorage(port, 'scheduler').collection('jobs').find();
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  port = createMemoryStorage();
  errors = [];
  storageErrors = [];
  services = [];
});

afterEach(async () => {
  for (const service of services) await service.stop();
  vi.useRealTimers();
});

describe('disparo', () => {
  it('chama o handler no horário com o payload e remove o job', async () => {
    const service = create();
    const scheduler = service.forPlugin('lembretes');
    const seen: JsonValue[] = [];
    scheduler.on('fire', (payload) => {
      seen.push(payload);
    });
    service.start();
    await scheduler.at(new Date(T0 + 5000), 'fire', { texto: 'oi' });

    await vi.advanceTimersByTimeAsync(4999);
    expect(seen).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(seen).toEqual([{ texto: 'oi' }]);
    expect(await storedJobs()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aceita epoch ms, payload ausente vira null e horário passado dispara logo', async () => {
    const service = create();
    const scheduler = service.forPlugin('p');
    const seen: JsonValue[] = [];
    scheduler.on('j', (payload) => {
      seen.push(payload);
    });
    service.start();
    await scheduler.at(T0 - 1000, 'j');
    await settle();
    expect(seen).toEqual([null]);
  });

  it('dispara em ordem de horário', async () => {
    const service = create();
    const scheduler = service.forPlugin('p');
    const seen: JsonValue[] = [];
    scheduler.on('j', (payload) => {
      seen.push(payload);
    });
    service.start();
    await scheduler.at(T0 + 300, 'j', 3);
    await scheduler.at(T0 + 100, 'j', 1);
    await scheduler.at(T0 + 200, 'j', 2);
    await vi.advanceTimersByTimeAsync(300);
    expect(seen).toEqual([1, 2, 3]);
  });

  it('não dispara antes de start()', async () => {
    const service = create();
    const scheduler = service.forPlugin('p');
    const handler = vi.fn();
    scheduler.on('j', handler);
    await scheduler.at(T0 + 100, 'j');
    await vi.advanceTimersByTimeAsync(1000);
    expect(handler).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    service.start();
    await settle();
    expect(handler).toHaveBeenCalledOnce();
  });

  it('job além do teto do setTimeout (~24,8 dias) dispara na data certa', async () => {
    const service = create();
    const scheduler = service.forPlugin('p');
    const firedAt: number[] = [];
    scheduler.on('j', () => {
      firedAt.push(Date.now());
    });
    service.start();
    await scheduler.at(T0 + 60 * DAY, 'j');
    await vi.advanceTimersByTimeAsync(30 * DAY);
    expect(firedAt).toEqual([]);
    await vi.advanceTimersByTimeAsync(30 * DAY);
    expect(firedAt).toEqual([T0 + 60 * DAY]);
  });
});

describe('um único loop para o bot inteiro', () => {
  it('no máximo um timer, de vários plugins e jobs', async () => {
    const service = create();
    service.start();
    await settle();
    expect(vi.getTimerCount()).toBe(0);

    for (const name of ['a', 'b', 'c']) {
      const scheduler = service.forPlugin(name);
      scheduler.on('j', () => undefined);
      for (let i = 1; i <= 5; i++) await scheduler.at(T0 + i * 1000, 'j');
    }
    await settle();
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(2500);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(await storedJobs()).toEqual([]);
  });

  it('agendar antes do armado rearma; depois não cria outro timer', async () => {
    const service = create();
    const scheduler = service.forPlugin('p');
    const seen: JsonValue[] = [];
    scheduler.on('j', (payload) => {
      seen.push(payload);
    });
    service.start();
    await scheduler.at(T0 + 10_000, 'j', 'tarde');
    await scheduler.at(T0 + 1000, 'j', 'cedo');
    await scheduler.at(T0 + 20_000, 'j', 'mais tarde');
    await settle();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(seen).toEqual(['cedo']);
  });
});

describe('namespace por plugin', () => {
  it('dois plugins usam o mesmo nome de job sem colidir', async () => {
    const service = create();
    const a = service.forPlugin('a');
    const b = service.forPlugin('b');
    const seenA: JsonValue[] = [];
    const seenB: JsonValue[] = [];
    a.on('fire', (p) => {
      seenA.push(p);
    });
    b.on('fire', (p) => {
      seenB.push(p);
    });
    service.start();
    await a.at(T0 + 100, 'fire', 'de a');
    await b.at(T0 + 100, 'fire', 'de b');
    await vi.advanceTimersByTimeAsync(100);
    expect(seenA).toEqual(['de a']);
    expect(seenB).toEqual(['de b']);
  });

  it('um plugin não cancela o job de outro', async () => {
    const service = create();
    const id = await service.forPlugin('a').at(T0 + 100, 'j');
    expect(await service.forPlugin('b').cancel(id)).toBe(false);
    expect(await service.forPlugin('a').cancel(id)).toBe(true);
  });
});

describe('persistência e restart', () => {
  it('jobs sobrevivem a restart', async () => {
    const first = create();
    await first.forPlugin('p').at(T0 + 5000, 'j', { n: 1 });
    first.start();
    await first.stop();
    expect(vi.getTimerCount()).toBe(0);

    const second = create();
    const seen: JsonValue[] = [];
    second.forPlugin('p').on('j', (payload) => {
      seen.push(payload);
    });
    second.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(seen).toEqual([{ n: 1 }]);
  });

  it('jobs vencidos durante o downtime disparam ao subir', async () => {
    const first = create();
    await first.forPlugin('p').at(T0 + 1000, 'j', 'atrasado');
    await first.forPlugin('p').at(T0 + 2 * DAY, 'j', 'futuro');
    first.start();
    await first.stop();

    // Bot desligado por um dia: nenhum timer vivo, nada dispara.
    vi.setSystemTime(T0 + DAY);

    const second = create();
    const seen: JsonValue[] = [];
    second.forPlugin('p').on('j', (payload) => {
      seen.push(payload);
    });
    second.start();
    await settle();
    expect(seen).toEqual(['atrasado']);
    await vi.advanceTimersByTimeAsync(DAY);
    expect(seen).toEqual(['atrasado', 'futuro']);
  });

  it('job cujo handler não terminou antes da queda é entregue de novo (pelo menos uma vez)', async () => {
    const first = create({ jobTimeoutMs: 10 * DAY });
    let calls = 0;
    first.forPlugin('p').on('j', () => {
      calls++;
      return new Promise(() => undefined);
    });
    first.start();
    await first.forPlugin('p').at(T0 + 100, 'j');
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toBe(1);
    // Queda: o processo morre sem stop() (o handler segue preso para sempre); o documento
    // continua no storage.
    services.splice(services.indexOf(first), 1);
    expect(await storedJobs()).toHaveLength(1);

    const second = create();
    const handler = vi.fn();
    second.forPlugin('p').on('j', handler);
    second.start();
    await settle();
    expect(handler).toHaveBeenCalledOnce();
  });
});

describe('job sem handler', () => {
  it('fica pendente até o plugin registrar o handler', async () => {
    const service = create();
    const scheduler = service.forPlugin('p');
    service.start();
    await scheduler.at(T0 + 100, 'j', 'x');
    await vi.advanceTimersByTimeAsync(1000);
    expect(await storedJobs()).toHaveLength(1);
    // Sem polling: o job vencido sem handler não mantém timer armado.
    expect(vi.getTimerCount()).toBe(0);

    const seen: JsonValue[] = [];
    scheduler.on('j', (payload) => {
      seen.push(payload);
    });
    await settle();
    expect(seen).toEqual(['x']);
    expect(await storedJobs()).toEqual([]);
  });

  it('removePlugin tira os handlers mas mantém os jobs (reload)', async () => {
    const service = create();
    const before = vi.fn();
    service.forPlugin('p').on('j', before);
    service.start();
    await service.forPlugin('p').at(T0 + 100, 'j');
    service.removePlugin('p');
    await vi.advanceTimersByTimeAsync(100);
    expect(before).not.toHaveBeenCalled();
    expect(await storedJobs()).toHaveLength(1);

    const after = vi.fn();
    service.forPlugin('p').on('j', after);
    await settle();
    expect(after).toHaveBeenCalledOnce();
  });

  it('unsubscribe desfaz só o próprio handler', async () => {
    const service = create();
    const scheduler = service.forPlugin('p');
    const off = scheduler.on('j', () => undefined);
    expect(() => scheduler.on('j', () => undefined)).toThrow(JobHandlerConflictError);
    off();
    const handler = vi.fn();
    const offNew = scheduler.on('j', handler);
    off(); // chamada repetida do antigo não remove o novo
    service.start();
    await scheduler.at(T0, 'j');
    await settle();
    expect(handler).toHaveBeenCalledOnce();
    offNew();
  });
});

describe('falhas', () => {
  it('handler que lança vira plugin.error e não derruba o loop', async () => {
    const service = create();
    const scheduler = service.forPlugin('p');
    const boom = new Error('boom');
    const ok = vi.fn();
    scheduler.on('ruim', () => {
      throw boom;
    });
    scheduler.on('bom', ok);
    service.start();
    await scheduler.at(T0 + 100, 'ruim');
    await scheduler.at(T0 + 200, 'bom');
    await vi.advanceTimersByTimeAsync(200);
    expect(errors).toEqual([
      { plugin: 'p', phase: 'scheduler', event: 'ruim', error: boom, timedOut: false },
    ]);
    expect(ok).toHaveBeenCalledOnce();
    // Sem retentativa: o job que falhou sai do storage.
    expect(await storedJobs()).toEqual([]);
  });

  it('handler que rejeita vira plugin.error', async () => {
    const service = create();
    const boom = new Error('async');
    service.forPlugin('p').on('j', async () => {
      throw boom;
    });
    service.start();
    await service.forPlugin('p').at(T0, 'j');
    await settle();
    expect(errors).toEqual([
      { plugin: 'p', phase: 'scheduler', event: 'j', error: boom, timedOut: false },
    ]);
  });

  it('handler que estoura o prazo vira plugin.error com timedOut', async () => {
    const service = create({ jobTimeoutMs: 500 });
    service.forPlugin('p').on('j', () => new Promise(() => undefined));
    service.start();
    await service.forPlugin('p').at(T0, 'j');
    await vi.advanceTimersByTimeAsync(499);
    expect(errors).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      plugin: 'p',
      phase: 'scheduler',
      event: 'j',
      timedOut: true,
    });
    expect(await storedJobs()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejeição depois do prazo vai ao onLateError, não vira um segundo plugin.error', async () => {
    const late: PluginErrorEvent[] = [];
    const boom = new Error('tarde');
    const service = create({ jobTimeoutMs: 500, onLateError: (e) => late.push(e) });
    service
      .forPlugin('p')
      .on('j', () => new Promise((_, reject) => setTimeout(() => reject(boom), 800)));
    service.start();
    await service.forPlugin('p').at(T0, 'j');
    await vi.advanceTimersByTimeAsync(800);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.timedOut).toBe(true);
    expect(late).toEqual([
      { plugin: 'p', phase: 'scheduler', event: 'j', error: boom, timedOut: false },
    ]);
  });

  it('recusa de contexto expirado depois do prazo não vai ao onLateError (ADR 0033)', async () => {
    const late: PluginErrorEvent[] = [];
    const service = create({ jobTimeoutMs: 500, onLateError: (e) => late.push(e) });
    const expired = new ContextExpiredError('p', 'send', 'job "j"', new Error('prazo'));
    service
      .forPlugin('p')
      .on('j', () => new Promise((_, reject) => setTimeout(() => reject(expired), 800)));
    service.start();
    await service.forPlugin('p').at(T0, 'j');
    await vi.advanceTimersByTimeAsync(800);
    expect(errors).toHaveLength(1);
    expect(late).toEqual([]);
  });

  it('falha do storage vai ao onStorageError e o loop tenta de novo', async () => {
    const real = kernelStorage(port, 'scheduler').collection('jobs');
    let failures = 1;
    const flaky: StoragePort = {
      ...port,
      forNamespace(namespace) {
        const storage = port.forNamespace(namespace);
        return {
          kv: storage.kv,
          collection: <T extends { readonly [key: string]: JsonValue }>() => {
            const c = real as unknown as Collection<T>;
            return {
              ...c,
              find: async (query) => {
                if (failures > 0) {
                  failures--;
                  throw new Error('storage fora');
                }
                return c.find(query);
              },
            };
          },
        };
      },
    };
    const service = create({ storage: flaky, storageRetryMs: 1000 });
    const handler = vi.fn();
    service.forPlugin('p').on('j', handler);
    await service.forPlugin('p').at(T0, 'j');
    service.start();
    await settle();
    expect(storageErrors).toHaveLength(1);
    expect(handler).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(handler).toHaveBeenCalledOnce();
  });
});

type AnyJobs = Collection<{ readonly [key: string]: JsonValue }>;

/** Storage cuja coleção de jobs passa por `wrap`: espiona ou quebra `find`/`delete`. */
function wrappedStorage(wrap: (jobs: AnyJobs) => Partial<AnyJobs>): StoragePort {
  const real = kernelStorage(port, 'scheduler').collection('jobs');
  return {
    ...port,
    forNamespace(namespace) {
      const storage = port.forNamespace(namespace);
      return {
        kv: storage.kv,
        collection: <T extends { readonly [key: string]: JsonValue }>() =>
          ({ ...real, ...wrap(real) }) as unknown as Collection<T>,
      };
    },
  };
}

describe('concorrência e paginação', () => {
  it('limita os handlers simultâneos e entrega todos os vencidos, em ordem de fireAt', async () => {
    const service = create({ maxConcurrentJobs: 5 });
    const scheduler = service.forPlugin('p');
    let running = 0;
    let peak = 0;
    const done: number[] = [];
    scheduler.on('job', async (payload) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 20));
      running--;
      done.push(payload as number);
    });
    for (let i = 0; i < 300; i++) await scheduler.at(i, 'job', i);
    service.start();

    await vi.advanceTimersByTimeAsync(20 * 60 + 100);

    expect(peak).toBe(5);
    expect(done).toHaveLength(300);
    expect(done.slice(0, 5)).toEqual([0, 1, 2, 3, 4]);
    expect(await storedJobs()).toEqual([]);
  });

  it('lê os vencidos em páginas, nunca a coleção inteira', async () => {
    const limits: (number | undefined)[] = [];
    const service = create({
      maxConcurrentJobs: 5,
      storage: wrappedStorage((jobs) => ({
        find: (query) => {
          limits.push(query?.limit);
          return jobs.find(query);
        },
      })),
    });
    const scheduler = service.forPlugin('p');
    scheduler.on('job', () => new Promise((r) => setTimeout(r, 10)));
    for (let i = 0; i < 300; i++) await scheduler.at(0, 'job');
    service.start();
    await vi.advanceTimersByTimeAsync(10 * 60 + 100);

    expect(limits.length).toBeGreaterThan(0);
    expect(limits.every((limit) => limit !== undefined && limit <= 100)).toBe(true);
  });

  it('vencidos sem handler (plugin desligado) não travam os dos outros plugins', async () => {
    const service = create({ maxConcurrentJobs: 5 });
    const off = service.forPlugin('desligado');
    for (let i = 0; i < 250; i++) await off.at(0, 'job');
    const handler = vi.fn();
    service.forPlugin('p').on('job', handler);
    await service.forPlugin('p').at(1, 'job');
    service.start();
    await settle();

    expect(handler).toHaveBeenCalledOnce();
  });

  it('vencidos sem handler não são relidos a cada disparo (#228)', async () => {
    const read: { plugin: string; job: string }[] = [];
    const service = create({
      storage: wrappedStorage((jobs) => ({
        find: async (query) => {
          const docs = await jobs.find(query);
          read.push(...(docs as unknown as { plugin: string; job: string }[]));
          return docs;
        },
      })),
    });
    // Órfãos dos dois jeitos: plugin sem handler nenhum e job sem handler de plugin vivo.
    const off = service.forPlugin('desligado');
    for (let i = 0; i < 300; i++) await off.at(T0 - 1000, 'y');
    const live = service.forPlugin('vivo');
    for (let i = 0; i < 300; i++) await live.at(T0 - 1000, 'renomeado');
    const handler = vi.fn();
    live.on('y', handler);
    service.start();
    for (let i = 0; i < 20; i++) await live.at(T0 - 1, 'y');
    await settle();

    expect(handler).toHaveBeenCalledTimes(20);
    expect(read.filter((doc) => doc.plugin === 'desligado')).toEqual([]);
    expect(read.filter((doc) => doc.job === 'renomeado')).toEqual([]);
  });

  it('job futuro sem handler não arma timer; o on do plugin o encontra', async () => {
    const service = create();
    const scheduler = service.forPlugin('p');
    await scheduler.at(T0 + 5000, 'job');
    service.start();
    await settle();
    expect(vi.getTimerCount()).toBe(0);

    const handler = vi.fn();
    scheduler.on('job', handler);
    await vi.advanceTimersByTimeAsync(5000);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('remoção que falha depois do handler rearma o loop: o job é entregue de novo', async () => {
    let failures = 1;
    const service = create({
      storageRetryMs: 1000,
      storage: wrappedStorage((jobs) => ({
        delete: async (target) => {
          if (failures > 0) {
            failures--;
            throw new Error('storage fora');
          }
          return jobs.delete(target);
        },
      })),
    });
    const handler = vi.fn();
    service.forPlugin('p').on('j', handler);
    await service.forPlugin('p').at(T0, 'j');
    service.start();
    await settle();
    expect(handler).toHaveBeenCalledOnce();
    expect(storageErrors).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(await storedJobs()).toEqual([]);
  });

  it('recusa maxConcurrentJobs inválido', () => {
    expect(() => create({ maxConcurrentJobs: 0 })).toThrow(RangeError);
    expect(() => create({ maxConcurrentJobs: 1.5 })).toThrow(RangeError);
  });
});

describe('validação de at', () => {
  it('recusa horário inválido', async () => {
    const scheduler = create().forPlugin('p');
    await expect(scheduler.at(new Date('nada'), 'j')).rejects.toThrow(TypeError);
    await expect(scheduler.at(Number.NaN, 'j')).rejects.toThrow(TypeError);
    await expect(scheduler.at(Number.POSITIVE_INFINITY, 'j')).rejects.toThrow(TypeError);
    await expect(scheduler.at('2026' as never, 'j')).rejects.toThrow(TypeError);
  });

  it('recusa nome de job vazio', async () => {
    const scheduler = create().forPlugin('p');
    await expect(scheduler.at(T0, '')).rejects.toThrow(TypeError);
    expect(() => scheduler.on('', () => undefined)).toThrow(TypeError);
  });

  it('recusa handler que não é função', () => {
    const scheduler = create().forPlugin('p');
    expect(() => scheduler.on('j', 'nada' as unknown as () => void)).toThrow(TypeError);
  });

  it('recusa payload que não é JSON', async () => {
    const scheduler = create().forPlugin('p');
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    const bad: unknown[] = [
      { a: undefined },
      [Number.NaN],
      new Date(),
      new Map(),
      () => 1,
      { n: 10n },
      cycle,
    ];
    for (const payload of bad) {
      await expect(scheduler.at(T0, 'j', payload as JsonValue)).rejects.toThrow(TypeError);
    }
    expect(await storedJobs()).toEqual([]);
  });

  it('aceita o mesmo objeto repetido sem ser ciclo', async () => {
    const scheduler = create().forPlugin('p');
    const shared = { x: 1 };
    await expect(scheduler.at(T0, 'j', { a: shared, b: [shared] })).resolves.toBeTypeOf('string');
  });

  it('recusa prazos inválidos nas opções', () => {
    expect(() => create({ jobTimeoutMs: 0 })).toThrow(RangeError);
    expect(() => create({ storageRetryMs: Number.NaN })).toThrow(RangeError);
  });
});

describe('cancel', () => {
  it('true antes de disparar e o job não dispara', async () => {
    const service = create();
    const scheduler = service.forPlugin('p');
    const handler = vi.fn();
    scheduler.on('j', handler);
    service.start();
    const id = await scheduler.at(T0 + 100, 'j');
    expect(await scheduler.cancel(id)).toBe(true);
    expect(await scheduler.cancel(id)).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(handler).not.toHaveBeenCalled();
  });

  it('false para id desconhecido, job já disparado ou em andamento', async () => {
    const service = create();
    const scheduler = service.forPlugin('p');
    let release: () => void = () => undefined;
    scheduler.on('lento', () => new Promise<void>((r) => (release = r)));
    scheduler.on('rapido', () => undefined);
    service.start();
    expect(await scheduler.cancel('nao-existe')).toBe(false);

    const fast = await scheduler.at(T0, 'rapido');
    const slow = await scheduler.at(T0, 'lento');
    await settle();
    expect(await scheduler.cancel(fast)).toBe(false);
    expect(await scheduler.cancel(slow)).toBe(false);
    release();
    await settle();
    expect(await storedJobs()).toEqual([]);
  });

  it('cancel concorrente com a volta do loop: ou cancela, ou dispara', async () => {
    const service = create();
    const scheduler = service.forPlugin('p');
    const handler = vi.fn();
    scheduler.on('j', handler);
    const id = await scheduler.at(T0, 'j');
    service.start(); // a volta do loop já leu o job vencido
    const cancelled = await scheduler.cancel(id);
    await settle();
    expect(cancelled).toBe(handler.mock.calls.length === 0);
  });
});

describe('stop', () => {
  it('desarma o timer e espera o handler em andamento', async () => {
    const service = create();
    const scheduler = service.forPlugin('p');
    let finished = false;
    scheduler.on('j', async () => {
      await new Promise((r) => setTimeout(r, 300));
      finished = true;
    });
    const later = vi.fn();
    scheduler.on('depois', later);
    service.start();
    await scheduler.at(T0, 'j');
    await scheduler.at(T0 + 10_000, 'depois');
    await settle();

    let stopped = false;
    const stopping = service.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(299);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    expect(finished).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(later).not.toHaveBeenCalled();
    expect(await storedJobs()).toHaveLength(1);
  });

  it('handler preso não segura o stop além do prazo do job', async () => {
    const service = create({ jobTimeoutMs: 1000 });
    service.forPlugin('p').on('j', () => new Promise(() => undefined));
    service.start();
    await service.forPlugin('p').at(T0, 'j');
    await settle();
    const stopping = service.stop();
    await vi.advanceTimersByTimeAsync(1000);
    await stopping;
    expect(errors[0]?.timedOut).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stop abortado abandona o handler: signal abortado, sem timer e job no storage', async () => {
    const service = create({ jobTimeoutMs: 60_000 });
    let signal: AbortSignal | undefined;
    service.forPlugin('p').on('j', (_payload, job) => {
      signal = job.signal;
      return new Promise(() => undefined);
    });
    service.start();
    await service.forPlugin('p').at(T0, 'j');
    await settle();

    const controller = new AbortController();
    const stopping = service.stop(controller.signal);
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await stopping;

    expect(signal?.aborted).toBe(true);
    expect(errors).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    // Não terminou: fica para a próxima subida (pelo menos uma vez).
    expect(await storedJobs()).toHaveLength(1);
  });

  it('at depois do stop persiste sem armar timer; start de novo retoma', async () => {
    const service = create();
    const handler = vi.fn();
    service.forPlugin('p').on('j', handler);
    service.start();
    await service.stop();
    await service.stop();
    await service.forPlugin('p').at(T0 + 100, 'j');
    expect(vi.getTimerCount()).toBe(0);
    service.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(handler).toHaveBeenCalledOnce();
  });
});

describe('every (série recorrente)', () => {
  const MIN = 60_000;

  it('dispara a cada intervalo com seriesId e scheduledAt exatos, sem deriva com handler lento', async () => {
    const service = create({ jobTimeoutMs: 60_000 });
    const scheduler = service.forPlugin('p');
    const seen: { id: string | undefined; at: number }[] = [];
    scheduler.on('j', async (_payload, job) => {
      seen.push({ id: job.seriesId, at: job.scheduledAt.getTime() });
      await new Promise((r) => setTimeout(r, 10_000));
    });
    service.start();
    const id = await scheduler.every({ everyMs: MIN }, 'j');

    await vi.advanceTimersByTimeAsync(3 * MIN);
    expect(seen).toEqual([
      { id, at: T0 + MIN },
      { id, at: T0 + 2 * MIN },
      { id, at: T0 + 3 * MIN },
    ]);
    expect(await storedJobs()).toHaveLength(1);
    // Deixa o handler da terceira ocorrência terminar: o stop do afterEach espera por ele.
    await vi.advanceTimersByTimeAsync(10_000);
  });

  it('regra de calendário cruza a mudança de horário de verão às 08:00 locais', async () => {
    vi.setSystemTime(Date.UTC(2026, 2, 7, 12, 0)); // 07:00 em Nova York (EST)
    const service = create();
    const scheduler = service.forPlugin('p');
    const seen: number[] = [];
    scheduler.on('j', (_p, job) => {
      seen.push(job.scheduledAt.getTime());
    });
    service.start();
    await scheduler.every({ time: '08:00', timeZone: 'America/New_York' }, 'j');
    await vi.advanceTimersByTimeAsync(3 * DAY - 1);
    expect(seen).toEqual([
      Date.UTC(2026, 2, 7, 13, 0), // EST (UTC-5)
      Date.UTC(2026, 2, 8, 12, 0), // EDT (UTC-4) a partir de 08/03
      Date.UTC(2026, 2, 9, 12, 0),
    ]);
  });

  it('cancel sem handler rodando devolve true e nada mais dispara', async () => {
    const service = create();
    const scheduler = service.forPlugin('p');
    const handler = vi.fn();
    scheduler.on('j', handler);
    service.start();
    const id = await scheduler.every({ everyMs: MIN }, 'j');
    expect(await scheduler.cancel(id)).toBe(true);
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(handler).not.toHaveBeenCalled();
  });

  it('cancel durante o handler devolve true e a série não renasce', async () => {
    const service = create({ jobTimeoutMs: 10 * MIN });
    const scheduler = service.forPlugin('p');
    let release: () => void = () => undefined;
    const handler = vi.fn(() => new Promise<void>((r) => (release = r)));
    scheduler.on('j', handler);
    service.start();
    const id = await scheduler.every({ everyMs: MIN }, 'j');
    await vi.advanceTimersByTimeAsync(MIN);
    expect(handler).toHaveBeenCalledOnce();

    expect(await scheduler.cancel(id)).toBe(true);
    release();
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(handler).toHaveBeenCalledOnce();
    expect(await storedJobs()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('handler que lança não interrompe a série', async () => {
    const service = create();
    const scheduler = service.forPlugin('p');
    const handler = vi.fn(() => {
      throw new Error('falhou');
    });
    scheduler.on('j', handler);
    service.start();
    await scheduler.every({ everyMs: MIN }, 'j');
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(errors).toHaveLength(2);
  });

  it('downtime: dispara uma vez ao subir (scheduledAt antigo) e a seguinte segue a regra', async () => {
    const first = create();
    const id = await first.forPlugin('p').every({ everyMs: DAY }, 'j');
    first.start();
    await first.stop();

    vi.setSystemTime(T0 + 3 * DAY + 1000);
    const second = create();
    const seen: { id: string | undefined; at: number }[] = [];
    second.forPlugin('p').on('j', (_p, job) => {
      seen.push({ id: job.seriesId, at: job.scheduledAt.getTime() });
    });
    second.start();
    await settle();
    expect(seen).toEqual([{ id, at: T0 + DAY }]);

    // Âncora no disparo perdido: a próxima é a primeira ocorrência da regra depois de agora.
    await vi.advanceTimersByTimeAsync(DAY);
    expect(seen).toEqual([
      { id, at: T0 + DAY },
      { id, at: T0 + 4 * DAY },
    ]);
  });

  it('next devolve a ocorrência pendente, a seguinte com handler rodando e undefined p/ desconhecidos', async () => {
    const service = create({ jobTimeoutMs: 10 * MIN });
    const scheduler = service.forPlugin('p');
    const releases: (() => void)[] = [];
    const hold = () => new Promise<void>((r) => releases.push(r));
    scheduler.on('j', hold);
    scheduler.on('a', hold);
    service.start();
    const id = await scheduler.every({ everyMs: 10 * MIN }, 'j');
    const at = await scheduler.at(T0 + 5 * MIN, 'a');
    expect(await scheduler.next(id)).toEqual(new Date(T0 + 10 * MIN));
    expect(await scheduler.next(at)).toEqual(new Date(T0 + 5 * MIN));
    expect(await scheduler.next('nao-existe')).toBeUndefined();
    expect(await service.forPlugin('outro').next(id)).toBeUndefined();

    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(await scheduler.next(id)).toEqual(new Date(T0 + 20 * MIN));
    expect(await scheduler.next(at)).toBeUndefined();
    for (const release of releases) release();
    await settle();
  });

  it('recusa regra, nome e payload inválidos com TypeError', async () => {
    const scheduler = create().forPlugin('p');
    await expect(scheduler.every({ everyMs: 1 }, 'j')).rejects.toThrow(TypeError);
    await expect(scheduler.every({ everyMs: MIN }, '')).rejects.toThrow(TypeError);
    await expect(
      scheduler.every({ everyMs: MIN }, 'j', { x: undefined } as unknown as JsonValue),
    ).rejects.toThrow(TypeError);
    expect(await storedJobs()).toEqual([]);
  });

  it('regra que não dá para calcular vai ao onError, apaga a série e não reentrega', async () => {
    const service = create();
    const handler = vi.fn();
    service.forPlugin('p').on('j', handler);
    const jobs = kernelStorage(port, 'scheduler').collection('jobs');
    await jobs.insert({
      plugin: 'p',
      job: 'j',
      fireAt: T0 - 1000,
      payload: null,
      rule: { time: '08:00', timeZone: 'Marte/Olympus' },
    });
    service.start();
    await settle();

    expect(handler).toHaveBeenCalledOnce();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      plugin: 'p',
      phase: 'scheduler',
      event: 'j',
      timedOut: false,
    });
    expect(await storedJobs()).toEqual([]);
    await vi.advanceTimersByTimeAsync(DAY);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('handler que cancela a própria série devolve true e não sobra documento', async () => {
    const service = create();
    const scheduler = service.forPlugin('p');
    let result: boolean | undefined;
    scheduler.on('j', async (_p, job) => {
      result = await scheduler.cancel(job.seriesId as string);
    });
    service.start();
    await scheduler.every({ everyMs: MIN }, 'j');
    await vi.advanceTimersByTimeAsync(MIN);

    expect(result).toBe(true);
    expect(await storedJobs()).toEqual([]);
  });

  it('outro plugin não cancela série em andamento', async () => {
    const service = create({ jobTimeoutMs: 10 * MIN });
    const scheduler = service.forPlugin('a');
    let release: () => void = () => undefined;
    scheduler.on('j', () => new Promise<void>((r) => (release = r)));
    service.start();
    const id = await scheduler.every({ everyMs: MIN }, 'j');
    await vi.advanceTimersByTimeAsync(MIN);

    expect(await service.forPlugin('b').cancel(id)).toBe(false);
    expect(await storedJobs()).toHaveLength(1);
    release();
    await settle();
  });

  it('downtime com regra de calendário dispara uma vez ao subir', async () => {
    const first = create();
    await first.forPlugin('p').every({ time: '08:00', timeZone: 'UTC' }, 'j');
    first.start();
    await first.stop();

    vi.setSystemTime(T0 + 3 * DAY + 12 * 60 * MIN);
    const second = create();
    const handler = vi.fn();
    second.forPlugin('p').on('j', handler);
    second.start();
    await settle();
    expect(handler).toHaveBeenCalledOnce();
  });
});
