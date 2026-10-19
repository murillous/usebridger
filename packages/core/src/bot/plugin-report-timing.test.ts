// Report de plugins: duração do setup, contagem por ponto, optionalDependsOn e horário do boot
// (M5-4.8, ADR 0110).

import { afterEach, describe, expect, it } from 'vitest';
import type { PluginAdmin } from '#bot/config.ts';
import { definePlugin } from '#plugin/define.ts';
import { createMemoryStorage } from '#storage/memory.ts';
import { type Bot, createBot } from './bot.ts';
import { RecordingTransport, recordingLogger } from './harness.test-support.ts';

declare module '@usebridger/core' {
  interface ExtensionPoints {
    'relatorio.pontos': () => void;
  }
}

const ENGINE = '>=0.0.0';
const bots: Bot[] = [];

afterEach(async () => {
  for (const created of bots.splice(0)) await created.stop().catch(() => undefined);
});

function make(admin: { current?: PluginAdmin } = {}): Bot {
  const b = createBot({
    env: {},
    logger: recordingLogger(),
    outbound: { globalIntervalMs: 0, chatIntervalMs: 0 },
    transport: new RecordingTransport(),
    storage: createMemoryStorage(),
    adminPlugins: ['lento'],
    plugins: [
      definePlugin({
        name: 'lento',
        version: '1.0.0',
        engine: ENGINE,
        optionalDependsOn: { rapido: '^1.0.0' },
        setup: async (ctx) => {
          admin.current = ctx.admin;
          ctx.services.contribute('relatorio.pontos', () => undefined);
          ctx.services.contribute('relatorio.pontos', () => undefined);
          await new Promise((resolve) => setTimeout(resolve, 30));
        },
      }),
      definePlugin({ name: 'rapido', version: '1.0.0', engine: ENGINE, setup: () => undefined }),
    ],
  });
  bots.push(b);
  return b;
}

describe('report de plugins: duração, contagem e boot', () => {
  it('mede o setup, conta contribuições por ponto e lista optionalDependsOn', async () => {
    const b = make();
    await b.start();
    const rows = Object.fromEntries(b.plugins().map((row) => [row.name, row]));
    expect(rows['lento']).toMatchObject({
      optionalDependsOn: { rapido: '^1.0.0' },
      contributions: ['relatorio.pontos'],
      contributionCounts: { 'relatorio.pontos': 2 },
    });
    expect(rows['rapido']).not.toHaveProperty('optionalDependsOn');
    expect(rows['rapido']).not.toHaveProperty('contributionCounts');
    expect(rows['lento']).toMatchObject({ setupMs: expect.any(Number) });
    expect((rows['lento'] as { setupMs: number }).setupMs).toBeGreaterThanOrEqual(25);
    expect((rows['rapido'] as { setupMs: number }).setupMs).toBeGreaterThanOrEqual(0);
  });

  it('plugin desligado não tem duração', async () => {
    const b = make();
    await b.start();
    await b.plugins.disable('rapido');
    expect(b.plugins().find((row) => row.name === 'rapido')).not.toHaveProperty('setupMs');
  });

  it('horário do boot: undefined antes do start, fixo depois, e igual por ctx.admin', async () => {
    const admin: { current?: PluginAdmin } = {};
    const b = make(admin);
    expect(b.plugins.bootedAt).toBeUndefined();
    const before = Date.now();
    await b.start();
    const { bootedAt } = b.plugins;
    expect(bootedAt).toBeGreaterThanOrEqual(before);
    expect(bootedAt).toBeLessThanOrEqual(Date.now());
    await b.plugins.reload('rapido');
    expect(b.plugins.bootedAt).toBe(bootedAt);
    expect(admin.current?.plugins.bootedAt).toBe(bootedAt);
    expect(admin.current?.plugins().find((row) => row.name === 'lento')).toMatchObject({
      setupMs: expect.any(Number),
    });
  });
});
