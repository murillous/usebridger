// ADR 0122: núcleo do log de auditoria (fila, cadeia, redação, ator, verify, query).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordingLogger } from '#bot/harness.test-support.ts';
import { createSecretSet } from '#logger/secrets.ts';
import { type ObserverSignals, Observers } from '#observers/observers.ts';
import { createMemoryStorage } from '#storage/memory.ts';
import { kernelStorage } from '#storage/namespace.ts';
import type { Collection, JsonObject } from '#storage/types.ts';
import { TenantScope } from '#tenant/scope.ts';
import { runInTrace } from '#trace/scope.ts';
import {
  AUDIT_COLLECTION,
  AUDIT_INDEXES,
  AUDIT_MAX_QUEUE,
  type Audit,
  AuditPermissionError,
  createAudit,
  verifyAudit,
} from './audit.ts';
import { runAsAuditSubject } from './scope.ts';
import type { AuditEvent } from './types.ts';

interface Setup {
  readonly audit: Audit;
  readonly col: Collection<JsonObject>;
  readonly tenants: TenantScope;
  readonly observers: Observers;
  readonly dropped: ObserverSignals['audit.dropped'][];
  readonly events: { includes(n: string): boolean; count(n: string): number };
  readonly clock: { time: number };
  readonly storage: ReturnType<typeof createMemoryStorage>;
}

const KEY = Buffer.alloc(32, 7);
const setups: Audit[] = [];

function setup(
  options: {
    storage?: ReturnType<typeof createMemoryStorage>;
    wrap?: (col: Collection<JsonObject>) => Collection<JsonObject>;
    observe?: boolean;
    secrets?: ReturnType<typeof createSecretSet>;
    keys?: { current?: Buffer; previous?: Buffer };
  } = {},
): Setup {
  const storage = options.storage ?? createMemoryStorage();
  const col = kernelStorage(storage, AUDIT_COLLECTION).collection<JsonObject>(AUDIT_COLLECTION, {
    indexes: AUDIT_INDEXES,
  });
  const tenants = new TenantScope();
  const observers = new Observers(() => undefined);
  const dropped: ObserverSignals['audit.dropped'][] = [];
  if (options.observe !== false) observers.add('t', 'audit.dropped', (s) => dropped.push(s));
  const log = recordingLogger();
  const events = {
    includes: (name: string) => log.lines.some((l) => l.fields['event'] === name),
    count: (name: string) => log.lines.filter((l) => l.fields['event'] === name).length,
  };
  const clock = { time: Date.UTC(2026, 9, 25, 12, 0, 0) };
  const audit = createAudit({
    collection: () => options.wrap?.(col) ?? col,
    session: 'default',
    tenants,
    log: () => log,
    observers,
    secrets: options.secrets ?? createSecretSet(),
    masterKeys: () => options.keys ?? { current: KEY },
    now: () => new Date(clock.time),
  });
  setups.push(audit);
  return { audit, col, tenants, observers, dropped, events, clock, storage };
}

const stored = async (col: Collection<JsonObject>): Promise<AuditEvent[]> =>
  (await col.find({ orderBy: 'seq' })) as unknown as AuditEvent[];

afterEach(() => {
  vi.useRealTimers();
  for (const audit of setups.splice(0)) audit.close();
});

describe('record e cadeia', () => {
  it('grava a cadeia com seq, prevHash, at do servidor, tenant, session e trace', async () => {
    const { audit, col, tenants } = setup();
    const plugin = audit.forPlugin('inbox', false);
    tenants.run('t1', () =>
      runInTrace('a'.repeat(32), () => {
        plugin.record({ action: 'inbox.ticket.transfer', target: { type: 'ticket', id: '9' } });
      }),
    );
    plugin.record({ action: 'inbox.ticket.close', outcome: 'denied' });
    await audit.flush();

    const [first, second] = await stored(col);
    expect(first).toMatchObject({
      v: 1,
      seq: 1,
      at: '2026-10-25T12:00:00.000Z',
      actor: { kind: 'plugin', name: 'inbox' },
      actorId: 'inbox',
      targetId: '9',
      tenant: 't1',
      session: 'default',
      trace: 'a'.repeat(32),
      outcome: 'success',
      prevHash: '0'.repeat(64),
    });
    expect(first?.eventId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(second).toMatchObject({ seq: 2, prevHash: first?.hash, outcome: 'denied' });
    expect(second?.tenant).toBeUndefined();
    expect(await audit.verify()).toEqual({ ok: true, checked: 2 });
  });

  it('continua a cadeia de onde o storage parou (releitura do topo no boot)', async () => {
    const first = setup();
    first.audit.record({ action: 'kernel.boot' });
    await first.audit.flush();
    const second = setup({ storage: first.storage });
    second.audit.record({ action: 'kernel.stop' });
    second.audit.start();
    await second.audit.flush();
    expect((await stored(second.col)).map((e) => e.seq)).toEqual([1, 2]);
    expect(await second.audit.verify()).toEqual({ ok: true, checked: 2 });
  });

  it('flush por tamanho: 100 eventos gravam sem esperar o relógio', async () => {
    vi.useFakeTimers();
    const { audit, col } = setup();
    audit.start();
    for (let i = 0; i < 100; i++) audit.record({ action: 'kernel.x' });
    await vi.advanceTimersByTimeAsync(0);
    expect(await col.find()).toHaveLength(100);
  });

  it('flush por tempo: 1 s depois do primeiro evento', async () => {
    vi.useFakeTimers();
    const { audit, col } = setup();
    audit.start();
    await vi.advanceTimersByTimeAsync(0); // fim da leitura do topo no boot
    audit.record({ action: 'kernel.x' });
    await vi.advanceTimersByTimeAsync(500);
    expect(await col.find()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(600);
    expect(await col.find()).toHaveLength(1);
  });

  it('o script do app verifica a cadeia só com storage e ambiente', async () => {
    const { audit, storage } = setup();
    audit.record({ action: 'kernel.x' });
    await audit.flush();
    const env = { BRIDGER_SECRET_KEY: KEY.toString('base64') };
    expect(await verifyAudit({ storage, env })).toMatchObject({ ok: true, checked: 1 });
    const wrongKey = { BRIDGER_SECRET_KEY: Buffer.alloc(32, 1).toString('base64') };
    expect(await verifyAudit({ storage, env: wrongKey })).toMatchObject({ ok: false });
  });
});

describe('ator e action', () => {
  it('o plugin não forja o ator: campos extras são ignorados', async () => {
    const { audit, col } = setup();
    const forged = { action: 'inbox.a', actor: { kind: 'system' }, via: 'x', tenant: 'y' };
    audit.forPlugin('inbox', false).record(forged as never);
    await audit.flush();
    const [event] = await stored(col);
    expect(event?.actor).toEqual({ kind: 'plugin', name: 'inbox' });
    expect(event?.via).toBeUndefined();
    expect(event?.tenant).toBeUndefined();
  });

  it('system só na gravação interna', async () => {
    const { audit, col } = setup();
    audit.record({ action: 'kernel.boot' });
    await audit.flush();
    expect((await stored(col))[0]).toMatchObject({ actor: { kind: 'system' }, actorId: 'system' });
  });

  it('o titular do escopo vira user/contact, com via e ip', async () => {
    const { audit, col } = setup();
    runAsAuditSubject(
      { actor: { kind: 'user', id: 'u1', name: 'Ana' }, ip: '10.0.0.1', userAgent: 'curl' },
      () => audit.forPlugin('inbox', false).record({ action: 'inbox.ticket.view' }),
    );
    runAsAuditSubject({ actor: { kind: 'contact', transport: 'wa', id: 'c1' } }, () =>
      audit.forPlugin('lgpd', false).record({ action: 'lgpd.export.request' }),
    );
    await audit.flush();
    const [user, contact] = await stored(col);
    expect(user).toMatchObject({
      actor: { kind: 'user', id: 'u1', name: 'Ana' },
      via: 'inbox',
      ip: '10.0.0.1',
      userAgent: 'curl',
    });
    expect(contact).toMatchObject({
      actor: { kind: 'contact', transport: 'wa', id: 'c1' },
      via: 'lgpd',
    });
  });

  it('a gravação interna aceita o ator explícito (plugin admin)', async () => {
    const { audit, col } = setup();
    audit.record({ action: 'kernel.plugin.disable', actor: { kind: 'plugin', name: 'dash' } });
    await audit.flush();
    const [event] = await stored(col);
    expect(event?.actor).toEqual({ kind: 'plugin', name: 'dash' });
    expect(event?.via).toBeUndefined();
  });

  it('exige o prefixo do plugin e reserva kernel. e audit.', () => {
    const plugin = setup().audit.forPlugin('inbox', false);
    expect(() => plugin.record({ action: 'outro.ticket.close' })).toThrow(TypeError);
    expect(() => plugin.record({ action: 'inbox.' })).toThrow(TypeError);
    expect(() => plugin.record({ action: 'inbox' })).toThrow(TypeError);
    expect(() => plugin.record({ action: 'kernel.plugin.disable' })).toThrow(/reservado/);
    expect(() => plugin.record({ action: 'audit.purge' })).toThrow(/reservado/);
    expect(() => plugin.record({ action: 'inbox.ok' })).not.toThrow();
    const kernelNamed = setup().audit.forPlugin('kernel', false);
    expect(() => kernelNamed.record({ action: 'kernel.x' })).toThrow(/reservado/);
  });
});

describe('redação de details', () => {
  it('censura chaves conhecidas, valores secretos e remove content', async () => {
    const secrets = createSecretSet();
    secrets.set('plugin:ai', ['sk-super-secreto-123']);
    const { audit, col } = setup({ secrets });
    audit.forPlugin('inbox', false).record({
      action: 'inbox.a',
      details: {
        Password: 'x',
        nested: { apiKey: 'k', API_KEY: 'k2', note: 'usou sk-super-secreto-123 aqui' },
        content: 'texto da mensagem',
        list: [{ content: 'x', token: 't' }],
        keep: 1,
      },
    });
    await audit.flush();
    expect((await stored(col))[0]?.details).toEqual({
      Password: '[REDACTED]',
      nested: { apiKey: '[REDACTED]', API_KEY: '[REDACTED]', note: 'usou [REDACTED] aqui' },
      list: [{ token: '[REDACTED]' }],
      keep: 1,
    });
  });

  it('includeContent mantém content, ação por ação', async () => {
    const { audit, col } = setup();
    const plugin = audit.forPlugin('inbox', false);
    plugin.record({ action: 'inbox.a', details: { content: 'oi' }, includeContent: true });
    plugin.record({ action: 'inbox.b', details: { content: 'oi' } });
    await audit.flush();
    const [a, b] = await stored(col);
    expect(a?.details).toEqual({ content: 'oi' });
    expect(b?.details).toEqual({});
  });

  it('valor que não é JSON lança no record', () => {
    const plugin = setup().audit.forPlugin('inbox', false);
    expect(() => plugin.record({ action: 'inbox.a', details: { fn: () => 1 } })).toThrow(TypeError);
    expect(() => plugin.record({ action: 'inbox.a', details: { big: 1n } })).toThrow(TypeError);
    expect(() => plugin.record({ action: 'inbox.a', details: { when: new Date() } })).toThrow(
      TypeError,
    );
  });
});

describe('falhas do storage', () => {
  it('retém, retenta com espera crescente e não duplica seq em falha ambígua', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const { audit, col, events } = setup({
      wrap: (real) => ({
        ...real,
        async insert(document) {
          calls++;
          if (calls === 1) {
            // Timeout ambíguo: o insert entrou, mas o dreno recebe erro.
            await real.insert(document);
            throw new Error('timeout');
          }
          if (calls === 2) throw new Error('fora do ar');
          return real.insert(document);
        },
      }),
    });
    audit.start();
    audit.record({ action: 'kernel.a' });
    audit.record({ action: 'kernel.b' });
    await vi.advanceTimersByTimeAsync(1000); // falha ambígua do 1º
    expect(events.includes('audit.flush.failed')).toBe(true);
    await vi.advanceTimersByTimeAsync(1000); // relê o topo, descarta o 1º da fila, falha no 2º
    await vi.advanceTimersByTimeAsync(2000); // espera dobrou: grava o 2º
    const rows = await stored(col);
    expect(rows.map((e) => [e.seq, e.action])).toEqual([
      [1, 'kernel.a'],
      [2, 'kernel.b'],
    ]);
    expect(await audit.verify()).toEqual({ ok: true, checked: 2 });
  });
});

describe('descartes e sinal audit.dropped', () => {
  it('fila cheia descarta o evento novo e emite o incremento', async () => {
    const { audit, dropped, events } = setup();
    for (let i = 0; i < AUDIT_MAX_QUEUE; i++) audit.record({ action: 'kernel.x' });
    expect(dropped).toEqual([]);
    audit.record({ action: 'kernel.x' });
    audit.record({ action: 'kernel.x' });
    expect(dropped).toEqual([
      { count: 1, reason: 'queue-full' },
      { count: 1, reason: 'queue-full' },
    ]);
    // O log sai por janela de 10 s (uma linha), o sinal sai a cada descarte.
    expect(events.count('audit.dropped')).toBe(1);
  });

  it('descartes antes do observador saem no primeiro sinal, como before-observer', () => {
    const { audit, observers, dropped } = setup({ observe: false });
    audit.close();
    audit.record({ action: 'kernel.x' });
    audit.record({ action: 'kernel.x' });
    expect(dropped).toEqual([]);
    observers.add('late', 'audit.dropped', (s) => dropped.push(s));
    audit.record({ action: 'kernel.x' });
    expect(dropped).toEqual([
      { count: 2, reason: 'before-observer' },
      { count: 1, reason: 'shutdown' },
    ]);
  });

  it('perda da trava descarta a fila sem gravar e recusa o que vier', async () => {
    const { audit, col, dropped, events } = setup();
    audit.record({ action: 'kernel.a' });
    audit.record({ action: 'kernel.b' });
    audit.leaseLost();
    audit.record({ action: 'kernel.c' });
    await audit.flush();
    expect(await col.find()).toHaveLength(0);
    expect(dropped).toEqual([
      { count: 2, reason: 'lease-lost' },
      { count: 1, reason: 'lease-lost' },
    ]);
    expect(events.includes('audit.dropped')).toBe(true);
  });

  it('stop drena a fila; o que passa do prazo vira shutdown', async () => {
    const ok = setup();
    ok.audit.start();
    ok.audit.record({ action: 'kernel.a' });
    await ok.audit.stop(AbortSignal.timeout(1000));
    expect(await ok.col.find()).toHaveLength(1);
    expect(ok.dropped).toEqual([]);

    const down = setup({
      wrap: (real) => ({
        ...real,
        insert: () => Promise.reject(new Error('fora do ar')),
      }),
    });
    down.audit.start();
    down.audit.record({ action: 'kernel.a' });
    down.audit.record({ action: 'kernel.b' });
    await down.audit.stop(AbortSignal.abort());
    expect(down.dropped).toEqual([{ count: 2, reason: 'shutdown' }]);
  });
});

describe('verify', () => {
  async function chain(n: number): Promise<Setup> {
    const s = setup();
    for (let i = 1; i <= n; i++) s.audit.record({ action: 'kernel.x', details: { i } });
    await s.audit.flush();
    return s;
  }

  it('aponta o primeiro elo quebrado quando um evento do meio é adulterado', async () => {
    const { audit, col } = await chain(5);
    const rows = await stored(col);
    await col.update({ seq: 3 }, { details: { i: 99 } });
    const result = await audit.verify();
    expect(result).toMatchObject({
      ok: false,
      checked: 2,
      brokenAt: { seq: 3, eventId: rows[2]?.eventId },
    });
  });

  it('quem edita e recalcula sem a chave também é pego', async () => {
    const { audit, col } = await chain(3);
    const [, second] = await stored(col);
    // Recalcula o hash com SHA-256 puro, sem a chave: não confere com o HMAC.
    const { createHash } = await import('node:crypto');
    await col.update(
      { seq: 2 },
      { hash: createHash('sha256').update(String(second?.hash)).digest('hex') },
    );
    expect(await audit.verify()).toMatchObject({ ok: false, brokenAt: { seq: 2 } });
  });

  it('evento removido do meio quebra no seguinte', async () => {
    const { audit, col } = await chain(4);
    await col.delete({ seq: 2 });
    expect(await audit.verify()).toMatchObject({ ok: false, brokenAt: { seq: 3 } });
  });

  it('prefixo apagado sem expurgação registrada quebra no primeiro elo restante', async () => {
    const { audit, col } = await chain(4);
    await col.delete({ seq: { lte: 2 } });
    expect(await audit.verify()).toMatchObject({ ok: false, checked: 0, brokenAt: { seq: 3 } });
  });

  async function withPurge(lastHash: (real: string) => string, toSeq = 2): Promise<Setup> {
    const s = await chain(3);
    const rows = await stored(s.col);
    s.audit.record({
      action: 'kernel.audit.purge',
      details: {
        fromSeq: 1,
        toSeq,
        count: toSeq,
        lastHash: lastHash(String(rows[toSeq - 1]?.hash)),
      },
    });
    await s.audit.flush();
    await s.col.delete({ seq: { lte: toSeq } });
    return s;
  }

  it('aceita o buraco de um kernel.audit.purge válido', async () => {
    const { audit } = await withPurge((hash) => hash);
    expect(await audit.verify()).toEqual({ ok: true, checked: 2 });
  });

  it('recusa o buraco quando lastHash ou toSeq não conferem', async () => {
    const wrongHash = await withPurge(() => 'f'.repeat(64));
    expect(await wrongHash.audit.verify()).toMatchObject({ ok: false, brokenAt: { seq: 3 } });
    // toSeq 1 declarado, mas o apagado foi até o 2: o primeiro restante não é toSeq + 1.
    const s = await chain(3);
    const rows = await stored(s.col);
    s.audit.record({
      action: 'kernel.audit.purge',
      details: { fromSeq: 1, toSeq: 1, count: 1, lastHash: rows[0]?.hash ?? '' },
    });
    await s.audit.flush();
    await s.col.delete({ seq: { lte: 2 } });
    expect(await s.audit.verify()).toMatchObject({ ok: false, brokenAt: { seq: 3 } });
  });
});

describe('query', () => {
  async function populated(): Promise<Setup> {
    const s = setup();
    const inbox = s.audit.forPlugin('inbox', true);
    const at = (minutes: number): void => {
      s.clock.time = Date.UTC(2026, 9, 25, 12, minutes, 0);
    };
    at(0);
    inbox.record({ action: 'inbox.ticket.open', target: { type: 'ticket', id: '1' } });
    at(10);
    s.tenants.run('t1', () => inbox.record({ action: 'inbox.ticket.close', outcome: 'denied' }));
    at(20);
    s.tenants.run('t2', () =>
      s.audit
        .forPlugin('lgpd', true)
        .record({ action: 'lgpd.export', target: { type: 'c', id: '1' } }),
    );
    at(30);
    s.audit.record({ action: 'kernel.boot' });
    await s.audit.flush();
    return s;
  }
  const seqs = (page: { events: readonly AuditEvent[] }): number[] => page.events.map((e) => e.seq);

  it('filtra por período, ator, ação, alvo, resultado e tenant', async () => {
    const { audit } = await populated();
    const q = audit.forPlugin('dash', true).query;
    expect(seqs(await q())).toEqual([1, 2, 3, 4]);
    expect(
      seqs(await q({ from: '2026-10-25T12:10:00.000Z', to: '2026-10-25T12:20:00.000Z' })),
    ).toEqual([2, 3]);
    expect(seqs(await q({ actor: 'lgpd' }))).toEqual([3]);
    expect(seqs(await q({ action: 'inbox.ticket.open' }))).toEqual([1]);
    expect(seqs(await q({ target: '1' }))).toEqual([1, 3]);
    expect(seqs(await q({ outcome: 'denied' }))).toEqual([2]);
    expect(seqs(await q({ tenant: 't2' }))).toEqual([3]);
  });

  it('pagina por cursor seq', async () => {
    const { audit } = await populated();
    const first = await audit.query({ limit: 2 });
    expect(seqs(first)).toEqual([1, 2]);
    expect(first.next).toBe(2);
    const second = await audit.query({ limit: 2, after: first.next });
    expect(seqs(second)).toEqual([3, 4]);
    const empty = await audit.query({ after: 4 });
    expect(empty).toEqual({ events: [] });
  });

  it('dentro de um tenant o filtro é imposto pelo core', async () => {
    const { audit, tenants } = await populated();
    const result = await tenants.run('t1', () => audit.query({ tenant: 't2' }));
    expect(seqs(result)).toEqual([2]);
  });

  it('query e verify exigem plugin admin', async () => {
    const { audit } = setup();
    const plugin = audit.forPlugin('inbox', false);
    await expect(plugin.query()).rejects.toBeInstanceOf(AuditPermissionError);
    await expect(plugin.verify()).rejects.toBeInstanceOf(AuditPermissionError);
    await expect(audit.forPlugin('dash', true).verify()).resolves.toMatchObject({ ok: true });
  });
});

describe('robustez do dreno', () => {
  it('stop não passa do prazo com insert pendurado', async () => {
    const { audit, dropped } = setup({
      wrap: (real) => ({ ...real, insert: () => new Promise<string>(() => undefined) }),
    });
    audit.start();
    audit.record({ action: 'kernel.a' });
    const started = Date.now();
    await audit.stop(AbortSignal.timeout(200));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(dropped).toEqual([{ count: 1, reason: 'shutdown' }]);
  });

  it('stop sem start descarta sem gravar', async () => {
    const { audit, col, dropped } = setup();
    audit.record({ action: 'kernel.a' });
    await audit.stop(AbortSignal.timeout(1000));
    expect(await col.find()).toHaveLength(0);
    expect(dropped).toEqual([{ count: 1, reason: 'shutdown' }]);
  });

  it('o backoff vale sob carga: poucas tentativas com record contínuo e fila passando de 100', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const { audit } = setup({
      wrap: (real) => ({
        ...real,
        insert: () => {
          attempts++;
          return Promise.reject(new Error('fora do ar'));
        },
      }),
    });
    audit.start();
    await vi.advanceTimersByTimeAsync(0);
    for (let t = 0; t < 20_000; t += 100) {
      for (let i = 0; i < 2; i++) audit.record({ action: 'kernel.x' });
      await vi.advanceTimersByTimeAsync(100);
    }
    // Esperas de 1, 2, 4, 8 e 16 s: no máximo 5 tentativas em 20 s.
    expect(attempts).toBeLessThanOrEqual(6);
    expect(attempts).toBeGreaterThanOrEqual(3);
  });

  it('flush concorrente com o timer e record durante o dreno gravam tudo uma vez', async () => {
    vi.useFakeTimers();
    const { audit, col } = setup({
      wrap: (real) => ({
        ...real,
        insert: async (document) => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return real.insert(document);
        },
      }),
    });
    audit.start();
    await vi.advanceTimersByTimeAsync(10);
    for (let i = 0; i < 3; i++) audit.record({ action: 'kernel.x' });
    const flushes = [audit.flush(), audit.flush()];
    await vi.advanceTimersByTimeAsync(7);
    audit.record({ action: 'kernel.y' }); // chega com o dreno em andamento
    audit.record({ action: 'kernel.y' });
    await vi.advanceTimersByTimeAsync(3000);
    await Promise.all(flushes);
    expect((await stored(col)).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(await audit.verify()).toEqual({ ok: true, checked: 5 });
  });

  it('evento que o storage recusa sempre é descartado como rejected', async () => {
    vi.useFakeTimers();
    const { audit, col, dropped } = setup({
      wrap: (real) => ({
        ...real,
        insert: (document) =>
          document['action'] === 'kernel.ruim'
            ? Promise.reject(new Error('recusado'))
            : real.insert(document),
      }),
    });
    audit.start();
    await vi.advanceTimersByTimeAsync(0);
    audit.record({ action: 'kernel.ruim' });
    audit.record({ action: 'kernel.bom' });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(dropped).toEqual([{ count: 1, reason: 'rejected' }]);
    expect((await stored(col)).map((e) => [e.seq, e.action])).toEqual([[1, 'kernel.bom']]);
  });

  it('recusa NUL, __proto__, target e limit inválidos', async () => {
    const { audit } = setup();
    const plugin = audit.forPlugin('inbox', true);
    expect(() => plugin.record({ action: 'inbox.a', details: { a: 'x\u0000y' } })).toThrow(
      TypeError,
    );
    expect(() =>
      plugin.record({ action: 'inbox.a', details: JSON.parse('{"__proto__": 1}') }),
    ).toThrow(TypeError);
    expect(() =>
      plugin.record({ action: 'inbox.a', target: { type: 'a', id: 1 } as never }),
    ).toThrow(TypeError);
    await expect(plugin.query({ limit: 0 })).rejects.toBeInstanceOf(TypeError);
    await expect(plugin.query({ limit: 1.5 })).rejects.toBeInstanceOf(TypeError);
  });
});

describe('rotação da chave', () => {
  const OLD = Buffer.alloc(32, 1);
  const NEW = Buffer.alloc(32, 2);

  async function rotated(): Promise<Setup> {
    const before = setup({ keys: { current: OLD } });
    before.audit.record({ action: 'kernel.a' });
    before.audit.record({ action: 'kernel.b' });
    await before.audit.flush();
    const after = setup({ storage: before.storage, keys: { current: NEW, previous: OLD } });
    after.audit.record({ action: 'kernel.c' });
    await after.audit.flush();
    return after;
  }

  it('aceita a chave anterior nos elos antes do primeiro assinado com a atual', async () => {
    const { audit } = await rotated();
    expect(await audit.verify()).toEqual({ ok: true, checked: 3 });
  });

  it('sem a anterior, o histórico antigo é acusado; e a anterior não vale depois da atual', async () => {
    const { storage, col } = await rotated();
    const noPrevious = setup({ storage, keys: { current: NEW } });
    expect(await noPrevious.audit.verify()).toMatchObject({ ok: false, brokenAt: { seq: 1 } });
    // Elo novo assinado com a chave antiga depois de um com a nova: forjado.
    const forger = setup({ storage, keys: { current: OLD } });
    forger.audit.record({ action: 'kernel.forjado' });
    await forger.audit.flush();
    const verifier = setup({ storage, keys: { current: NEW, previous: OLD } });
    expect(await verifier.audit.verify()).toMatchObject({ ok: false, brokenAt: { seq: 4 } });
    expect(await col.find()).toHaveLength(4);
  });
});
