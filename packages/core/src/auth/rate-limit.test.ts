// M7-4 (ADR 0128): o rate limit vive no storage, não na memória do limiter.

import { describe, expect, it } from 'vitest';
import { createMemoryStorage } from '#storage/memory.ts';
import { createLoginLimiter } from './rate-limit.ts';

const T0 = new Date('2026-01-01T00:00:00Z');

function setup() {
  const storage = createMemoryStorage().forNamespace('auth');
  const clock = { now: T0 };
  const make = () => createLoginLimiter({ storage, now: () => clock.now });
  return { clock, make, storage };
}

describe('rate limit persistido', () => {
  it('falhas valem num limiter novo sobre o mesmo storage (restart)', async () => {
    const { make } = setup();
    const first = make();
    for (let i = 0; i < 5; i++) await first.fail(['email:a@x.com']);
    expect(await make().wait(['email:a@x.com'])).toBe(30_000);
  });

  it('dois limiters simultâneos somam as falhas (dois processos)', async () => {
    const { make } = setup();
    const [a, b] = [make(), make()];
    await Promise.all([
      ...Array.from({ length: 3 }, () => a.fail(['ip:1'])),
      ...Array.from({ length: 2 }, () => b.fail(['ip:1'])),
    ]);
    expect(await a.wait(['ip:1'])).toBe(30_000);
    expect(await b.wait(['ip:1'])).toBe(30_000);
  });

  it('janela vencida recomeça a contagem e reset limpa só a chave', async () => {
    const { make, clock } = setup();
    const limiter = make();
    for (let i = 0; i < 5; i++) await limiter.fail(['k', 'other']);
    await limiter.reset('k');
    expect(await limiter.wait(['k'])).toBe(0);
    expect(await limiter.wait(['other'])).toBeGreaterThan(0);
    clock.now = new Date(T0.getTime() + 16 * 60_000);
    await limiter.fail(['other']);
    expect(await limiter.wait(['other'])).toBe(0);
  });

  it('refund desfaz a falha e limpa o bloqueio quando count < max', async () => {
    const { make } = setup();
    const limiter = make();
    for (let i = 0; i < 5; i++) await limiter.fail(['k']);
    expect(await limiter.wait(['k'])).toBe(30_000);
    await make().refund(['k']);
    expect(await limiter.wait(['k'])).toBe(0);
  });

  it('a espera dobra a cada falha seguinte, também num limiter novo', async () => {
    const { make } = setup();
    for (let i = 0; i < 5; i++) await make().fail(['k']);
    expect(await make().wait(['k'])).toBe(30_000);
    await make().fail(['k']);
    expect(await make().wait(['k'])).toBe(60_000);
  });

  it('varre documentos vencidos de outras chaves e mantém os ativos', async () => {
    const { make, clock, storage } = setup();
    const limiter = make();
    await limiter.fail(['velha']);
    clock.now = new Date(T0.getTime() + 16 * 60_000);
    await limiter.fail(['nova']);
    const docs = await storage.collection('rateLimits').find();
    expect(docs).toHaveLength(1);
    expect(docs[0]?.['count']).toBe(1);
  });

  it('não guarda o e-mail nem o IP em claro', async () => {
    const { make, storage } = setup();
    await make().fail(['email:segredo@x.com', 'ip:10.0.0.1']);
    const text = JSON.stringify(await storage.collection('rateLimits').find());
    expect(text).not.toContain('segredo');
    expect(text).not.toContain('10.0.0.1');
  });
});
