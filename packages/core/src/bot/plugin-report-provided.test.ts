// Tabela de plugins traz dependsOn, serviços providos e contribuições (M5-4.7, ADR 0112).

import { afterEach, describe, expect, it } from 'vitest';
import { definePlugin } from '#plugin/define.ts';
import { createMemoryStorage } from '#storage/memory.ts';
import { type Bot, createBot } from './bot.ts';
import { RecordingTransport, recordingLogger } from './harness.test-support.ts';

declare module '@usebridger/core' {
  interface Services {
    'relatorio.teste': { ok: true };
  }
  interface ExtensionPoints {
    'relatorio.etapas': () => void;
  }
}

const ENGINE = '>=0.0.0';
const bots: Bot[] = [];

afterEach(async () => {
  for (const created of bots.splice(0)) await created.stop().catch(() => undefined);
});

describe('PluginReportEntry: dependsOn, services e contributions', () => {
  it('lista o que cada plugin declara, proveu e contribuiu; some ao desativar', async () => {
    const b = createBot({
      env: {},
      logger: recordingLogger(),
      outbound: { globalIntervalMs: 0, chatIntervalMs: 0 },
      transport: new RecordingTransport(),
      storage: createMemoryStorage(),
      plugins: [
        definePlugin({
          name: 'base',
          version: '1.0.0',
          engine: ENGINE,
          setup: (ctx) => ctx.services.provide('relatorio.teste', { ok: true }),
        }),
        definePlugin({
          name: 'filho',
          version: '1.0.0',
          engine: ENGINE,
          dependsOn: { base: '^1.0.0' },
          setup: (ctx) => ctx.services.contribute('relatorio.etapas', () => undefined),
        }),
        definePlugin({ name: 'quieto', version: '1.0.0', engine: ENGINE, setup: () => undefined }),
      ],
    });
    bots.push(b);
    await b.start();

    const rows = Object.fromEntries(b.plugins().map((row) => [row.name, row]));
    expect(rows['base']).toMatchObject({ services: ['relatorio.teste'] });
    expect(rows['filho']).toMatchObject({
      dependsOn: { base: '^1.0.0' },
      contributions: ['relatorio.etapas'],
    });
    expect(Object.keys(rows['quieto'] ?? {})).toEqual([
      'name',
      'version',
      'origin',
      'status',
      'setupMs',
    ]);

    await b.plugins.disable('base');
    const base = b.plugins().find((row) => row.name === 'base');
    expect(base?.status).toBe('skipped');
    expect(base).not.toHaveProperty('services');
  });
});

describe('provide depois do setup', () => {
  it('aparece no report sem reload', async () => {
    let late: (() => void) | undefined;
    const b = createBot({
      env: {},
      logger: recordingLogger(),
      outbound: { globalIntervalMs: 0, chatIntervalMs: 0 },
      transport: new RecordingTransport(),
      storage: createMemoryStorage(),
      plugins: [
        definePlugin({
          name: 'tardio',
          version: '1.0.0',
          engine: ENGINE,
          setup: (ctx) => {
            late = () => ctx.services.provide('relatorio.teste', { ok: true });
          },
        }),
      ],
    });
    bots.push(b);
    await b.start();
    expect(b.plugins()[0]).not.toHaveProperty('services');

    late?.();
    expect(b.plugins()[0]).toMatchObject({ services: ['relatorio.teste'] });
  });
});
