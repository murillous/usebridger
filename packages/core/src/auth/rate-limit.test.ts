// M7-4 (ADR 0128): o rate limit vive no storage, não na memória do limiter.

import { describe, expect, it } from 'vitest';
import { createMemoryStorage } from '#storage/memory.ts';
import { createLoginLimiter } from './rate-limit.ts';

const T0 = new Date('2026-01-01T00:00:00Z');

function setup() {
  const storage = createMemoryStorage().forNamespace('auth');
  const clock = { now: T0 };
  const make = () => createLoginLimiter({ storage, now: () => clock.now });
  return { clock, make };
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
    expect(await a.wait(['ip:1'])).toBeGreaterThan(0);
    expect(await b.wait(['ip:1'])).toBeGreaterThan(0);
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
});
