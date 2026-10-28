// scrapeToken no GET /metrics (#240): Bearer em tempo constante, 401 genérico e warn sem token.

import { createHttp, definePlugin, type Logger, type PluginContext } from '@usebridger/core';
import { createTestBot } from '@usebridger/testing';
import { describe, expect, it } from 'vitest';
import { metrics } from './index.ts';

const TOKEN = 'token-do-scrape-com-32-caracteres';

// Guarda tudo o que passa pelo logger, para provar que o token não sai em lugar nenhum.
function fakeLog(): { log: Logger; events: string[]; dump: () => string } {
  const events: string[] = [];
  const calls: unknown[] = [];
  const keep =
    (level: string) =>
    (...args: unknown[]): void =>
      void calls.push([level, ...args]);
  const log: Logger = {
    level: 'info',
    trace: keep('trace'),
    debug: keep('debug'),
    info: keep('info'),
    warn: keep('warn'),
    error: keep('error'),
    fatal: keep('fatal'),
    event: (event, fields) => {
      events.push(event.name);
      calls.push([event.name, fields]);
    },
    child: () => log,
  };
  return { log, events, dump: () => JSON.stringify(calls) };
}

async function boot(scrapeToken?: string) {
  const http = createHttp({ port: 0, hostname: '127.0.0.1' });
  const logs = fakeLog();
  const bot = await createTestBot({
    plugins: [metrics],
    http,
    logger: logs.log,
    pluginConfig: { metrics: scrapeToken === undefined ? {} : { scrapeToken } },
  });
  const scrape = (authorization?: string): Promise<Response> =>
    fetch(`http://127.0.0.1:${http.port}/plugins/metrics/metrics`, {
      headers: authorization === undefined ? {} : { authorization },
    });
  return { bot, scrape, ...logs };
}

describe('GET /metrics com scrapeToken', () => {
  it.each([
    ['sem cabeçalho', undefined],
    ['com token errado', `Bearer ${'x'.repeat(TOKEN.length)}`],
    ['com tamanho diferente', `Bearer ${TOKEN}a`],
    ['com esquema diferente de Bearer', `Basic ${TOKEN}`],
  ])('responde 401 genérico %s', async (_, authorization) => {
    const { bot, scrape } = await boot(TOKEN);
    const res = await scrape(authorization);
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('unauthorized');
    await bot.stop();
  });

  it('responde 200 com o token certo (esquema sem diferenciar caixa)', async () => {
    const { bot, scrape, events } = await boot(TOKEN);
    const res = await scrape(`Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('bridger_messages_handled_total');
    expect((await scrape(`bearer ${TOKEN}`)).status).toBe(200);
    expect(events).not.toContain('metrics.scrape.open');
    await bot.stop();
  });

  it('o token não aparece no log, nem o cabeçalho recusado', async () => {
    const { bot, scrape, dump } = await boot(TOKEN);
    await scrape(`Bearer ${TOKEN}`);
    await scrape('Bearer cabecalho-recusado-123');
    await bot.stop();
    expect(dump()).not.toContain(TOKEN);
    expect(dump()).not.toContain('cabecalho-recusado-123');
  });
});

describe('scrapeToken como segredo (ADR 0117)', () => {
  const KEY = Buffer.alloc(32, 7).toString('base64');
  const NEW_TOKEN = 'token-novo-do-scrape-gravado-cifrado';

  // Plugin admin que só guarda o `ctx.admin`, como o dashboard faria.
  async function bootAdmin(pluginConfig: Record<string, Record<string, unknown>>) {
    const http = createHttp({ port: 0, hostname: '127.0.0.1' });
    let admin: PluginContext['admin'];
    const dash = definePlugin({
      name: 'dash',
      version: '1.0.0',
      engine: '<1.0.0',
      setup(ctx) {
        admin = ctx.admin;
      },
    });
    const bot = await createTestBot({
      plugins: [metrics, dash],
      http,
      env: { BRIDGER_SECRET_KEY: KEY },
      adminPlugins: ['dash'],
      pluginConfig,
    });
    if (!admin) throw new Error('sem admin');
    const scrape = (token?: string): Promise<number> =>
      fetch(`http://127.0.0.1:${http.port}/plugins/metrics/metrics`, {
        headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
      }).then((res) => res.status);
    return { bot, config: admin.config, scrape };
  }

  it('describe mascara o token e o JSON Schema o marca como segredo editável', async () => {
    const { bot, config } = await bootAdmin({ metrics: { scrapeToken: TOKEN } });
    const view = await config.describe('metrics');
    expect((view.config as { scrapeToken: string }).scrapeToken).toBe('********');
    expect(JSON.stringify(view)).not.toContain(TOKEN);
    const field = (
      config.jsonSchema('metrics') as { properties: Record<string, Record<string, unknown>> }
    ).properties['scrapeToken'];
    expect(field).toMatchObject({
      secret: true,
      writeOnly: true,
      'x-bridger-set-secret': true,
    });
    await bot.stop();
  });

  it('setSecret liga o token sem reiniciar o bot e clearSecret abre a rota de novo', async () => {
    const { bot, config, scrape } = await bootAdmin({});
    expect(await scrape()).toBe(200);

    await config.setSecret('metrics', 'scrapeToken', NEW_TOKEN);
    expect(await scrape()).toBe(401);
    expect(await scrape(NEW_TOKEN)).toBe(200);
    expect(JSON.stringify(await config.describe('metrics'))).not.toContain(NEW_TOKEN);

    await config.clearSecret('metrics', 'scrapeToken');
    expect(await scrape()).toBe(200);
    await bot.stop();
  });
});

describe('GET /metrics sem scrapeToken', () => {
  it('fica aberta e registra um warn no boot com o caminho da rota', async () => {
    const { bot, scrape, events, dump } = await boot();
    expect((await scrape()).status).toBe(200);
    expect(events.filter((name) => name === 'metrics.scrape.open')).toHaveLength(1);
    expect(dump()).toContain('"path":"/plugins/metrics/metrics"');
    await bot.stop();
  });
});
