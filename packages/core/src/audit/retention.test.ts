// ADR 0122: retenção e expurgação da auditoria (prefixo por seq, purge antes do delete, verify).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordingLogger } from '#bot/harness.test-support.ts';
import { BotConfigError } from '#config/owners.ts';
import { createSecretSet } from '#logger/secrets.ts';
import { Observers } from '#observers/observers.ts';
import { createMemoryStorage } from '#storage/memory.ts';
import { kernelStorage } from '#storage/namespace.ts';
import type { Collection, JsonObject } from '#storage/types.ts';
import { TenantScope } from '#tenant/scope.ts';
import { AUDIT_COLLECTION, AUDIT_INDEXES, type Audit, createAudit } from './audit.ts';
import { createAuditRetention, validateRetentionDays } from './retention.ts';
import type { AuditEvent } from './types.ts';

const KEY = Buffer.alloc(32, 7);
const NOW = Date.UTC(2026, 9, 25, 12, 0, 0);
const DAY = 86_400_000;
const OLD = NOW - 400 * DAY;
const RECENT = NOW - DAY;
const audits: Audit[] = [];

function setup() {
  const col = kernelStorage(createMemoryStorage(), AUDIT_COLLECTION).collection<JsonObject>(
    AUDIT_COLLECTION,
    { indexes: AUDIT_INDEXES },
  );
  const failures = { insert: false };
  const deleted: { purgeAlreadyStored: boolean }[] = [];
  const wrapped: Collection<JsonObject> = {
    ...col,
    insert: (doc) =>
      failures.insert ? Promise.reject(new Error('storage fora')) : col.insert(doc),
    delete: async (target) => {
      const purges = await col.find({ where: { action: 'kernel.audit.purge' } });
      deleted.push({ purgeAlreadyStored: purges.length > 0 });
      return col.delete(target);
    },
  } as Collection<JsonObject>;
  const log = recordingLogger();
  const clock = { time: NOW };
  const today = { time: NOW };
  const audit = createAudit({
    collection: () => wrapped,
    session: 'default',
    tenants: new TenantScope(),
    log: () => log,
    observers: new Observers(() => undefined),
    secrets: createSecretSet(),
    masterKeys: () => ({ current: KEY }),
    now: () => new Date(clock.time),
    onFlushed: () => retention.tick(),
  });
  audits.push(audit);
  audit.start();
  const retention = createAuditRetention({
    audit,
    collection: () => wrapped,
    retentionDays: 365,
    log: () => log,
    now: () => new Date(today.time),
  });
  const add = async (time: number, action = 'kernel.test') => {
    clock.time = time;
    audit.record({ action });
    await audit.flush();
  };
  const seqs = async () =>
    ((await col.find({ orderBy: 'seq' })) as unknown as AuditEvent[]).map((e) => e.seq);
  const logged = (name: string) => log.lines.some((l) => l.fields['event'] === name);
  return { audit, col, add, seqs, retention, failures, deleted, logged, today };
}

afterEach(() => {
  vi.useRealTimers();
  for (const audit of audits.splice(0)) audit.close();
});

describe('expurgação da auditoria', () => {
  it('apaga só seq <= toSeq, grava o purge antes e a cadeia continua verificável', async () => {
    const t = setup();
    for (const at of [OLD, OLD, OLD, RECENT, RECENT]) await t.add(at);
    expect(await t.retention.purge()).toBe(3);

    expect(t.deleted).toEqual([{ purgeAlreadyStored: true }]);
    expect(await t.seqs()).toEqual([4, 5, 6]);
    const purge = ((await t.col.find({ where: { seq: 6 } })) as unknown as AuditEvent[])[0];
    expect(purge?.action).toBe('kernel.audit.purge');
    expect(purge?.actor).toEqual({ kind: 'system' });
    expect(purge?.session).toBe('default');
    expect(purge?.details).toMatchObject({ fromSeq: 1, toSeq: 3, count: 3 });
    expect(await t.audit.verify()).toMatchObject({ ok: true, checked: 3 });
  });

  it('relógio que voltou: apaga o prefixo contíguo até o maior seq vencido', async () => {
    const t = setup();
    for (const at of [RECENT, OLD, RECENT]) await t.add(at);
    expect(await t.retention.purge()).toBe(2);
    expect(await t.seqs()).toEqual([3, 4]);
    expect(await t.audit.verify()).toMatchObject({ ok: true });
  });

  it('segunda expurgação depois da primeira também verifica', async () => {
    const t = setup();
    for (const at of [OLD, RECENT]) await t.add(at);
    await t.retention.purge();
    await t.add(OLD); // chega com `at` antigo depois do primeiro purge
    expect(await t.retention.purge()).toBeGreaterThan(0);
    expect(await t.audit.verify()).toMatchObject({ ok: true });
    expect((await t.seqs()).at(-1)).toBeGreaterThan(3);
  });

  it('nada vencido não grava evento', async () => {
    const t = setup();
    await t.add(RECENT);
    expect(await t.retention.purge()).toBe(0);
    expect(await t.seqs()).toEqual([1]);
    expect(t.deleted).toEqual([]);
  });

  it('storage falhando no flush não apaga nada e tenta na próxima', async () => {
    const t = setup();
    for (const at of [OLD, RECENT]) await t.add(at);
    t.failures.insert = true;
    expect(await t.retention.purge()).toBe(0);
    expect(t.deleted).toEqual([]);
    expect(await t.seqs()).toEqual([1, 2]);
    expect(t.logged('audit.purge.skipped')).toBe(true);
  });
});

describe('gatilho pela gravação', () => {
  it('só depois de start, e no máximo uma passada por dia', async () => {
    const t = setup();
    await t.add(OLD);
    await t.add(OLD);
    expect(await t.seqs()).toEqual([1, 2]); // sem start: nada expurgado

    let mono = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => mono);
    t.retention.start();
    await t.add(NOW - 2 * DAY); // dispara a primeira passada
    await vi.waitFor(async () => expect(await t.seqs()).toEqual([3, 4]));
    expect(t.deleted).toHaveLength(1);

    await t.add(OLD); // mesmo dia: não passa de novo
    await t.add(NOW - 2 * DAY);
    expect(t.deleted).toHaveLength(1);

    mono += DAY;
    await t.add(NOW + DAY); // um dia depois: nova passada
    await vi.waitFor(() => expect(t.deleted).toHaveLength(2));
  });
});

describe('stop com passada em voo', () => {
  it('espera a passada, que desiste sem gravar nem apagar depois do stop', async () => {
    const t = setup();
    for (const at of [OLD, RECENT]) await t.add(at);
    t.retention.start();
    const inFlight = t.retention.purge();
    await t.retention.stop();
    expect(await inFlight).toBe(0);
    audits[0]?.close();
    expect(t.deleted).toEqual([]);
    expect(await t.seqs()).toEqual([1, 2]); // nenhum purge gravado
  });

  it('apaga em lotes de 1000', async () => {
    const t = setup();
    for (let i = 0; i < 1500; i++) t.audit.record({ action: 'kernel.test' });
    await t.audit.flush();
    await t.audit.flush();
    // todos com `at` do relógio do audit (NOW): corte futuro os vence
    t.today.time = NOW + 400 * DAY;
    expect(await t.retention.purge()).toBe(1500);
    expect(t.deleted).toHaveLength(2);
    expect(await t.audit.verify()).toMatchObject({ ok: true });
  });
});

describe('timers', () => {
  it('o timer de 1 s armado pelo record do purge é cancelado pelo flush', async () => {
    const t = setup();
    for (const at of [OLD, RECENT]) await t.add(at);
    vi.useFakeTimers();
    await t.retention.purge();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('purge interrompido entre lotes', () => {
  it('verify passa com o início dentro do intervalo registrado e acusa buraco fora dele', async () => {
    const t = setup();
    for (let i = 0; i < 1500; i++) t.audit.record({ action: 'kernel.test' });
    await t.audit.flush();
    await t.audit.flush();
    const rows = (await t.col.find({ orderBy: 'seq' })) as unknown as AuditEvent[];
    t.audit.record({
      action: 'kernel.audit.purge',
      details: { fromSeq: 1, toSeq: 1500, count: 1500, lastHash: String(rows[1499]?.hash) },
    });
    await t.audit.flush();
    await t.col.delete({ seq: { lte: 1000 } }); // parou depois do primeiro lote
    expect(await t.audit.verify()).toMatchObject({ ok: true, checked: 501 });

    // Buraco no meio do intervalo ainda é acusado pelo encadeamento.
    await t.col.delete({ seq: 1200 });
    expect(await t.audit.verify()).toMatchObject({ ok: false, brokenAt: { seq: 1201 } });
  });
});

describe('audit.retentionDays', () => {
  it('padrão 1825; inteiro positivo ou BotConfigError', () => {
    expect(validateRetentionDays(undefined)).toBe(1825);
    expect(validateRetentionDays(30)).toBe(30);
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => validateRetentionDays(bad)).toThrow(BotConfigError);
    }
  });
});
