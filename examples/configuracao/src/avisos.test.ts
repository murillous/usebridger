import { createHttp, PluginBootError } from '@usebridger/core';
import { createTestBot } from '@usebridger/testing';
import { expect, it } from 'vitest';
import { avisos } from './avisos.ts';

const TOKEN = 'token-de-teste-1234567890';

// #region teste
// O kit não lê o `process.env` da máquina: o ambiente do teste é só o que vai em `env`.
const env = { BRIDGER_AVISOS__CHAT: 'grupo@g.us', BRIDGER_AVISOS__TOKEN: TOKEN };

async function subir() {
  const http = createHttp({ port: 0, hostname: '127.0.0.1' });
  const bot = await createTestBot({ plugins: [avisos], http, env });
  const avisar = (texto: string, token = TOKEN) =>
    fetch(`http://127.0.0.1:${http.port}/plugins/avisos`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: texto,
    });
  return { bot, avisar };
}
// #endregion teste

it('manda o aviso no chat da config, com o prefixo padrão', async () => {
  const { bot, avisar } = await subir();

  const resposta = await avisar('deploy feito');
  await bot.bot.settled();

  expect(resposta.status).toBe(204);
  expect(bot.sent[0]?.chatId).toBe('grupo@g.us');
  expect(bot.sent).toContainText('📢 deploy feito');
  await bot.stop();
});

it('recusa token errado', async () => {
  const { bot, avisar } = await subir();

  const resposta = await avisar('deploy feito', 'outro-token-qualquer-123');

  expect(resposta.status).toBe(401);
  expect(bot.sent).toHaveLength(0);
  await bot.stop();
});

it('o pluginConfig vale abaixo da env', async () => {
  const http = createHttp({ port: 0, hostname: '127.0.0.1' });
  const bot = await createTestBot({
    plugins: [avisos],
    http,
    env,
    pluginConfig: { avisos: { chat: 'perdido@g.us', prefixo: '🚨' } },
  });

  const { config, sources } = await bot.bot.config.describe('avisos');

  expect(config).toMatchObject({ chat: 'grupo@g.us', prefixo: '🚨', token: '********' });
  expect(sources).toMatchObject({ chat: 'env', prefixo: 'file', token: 'env' });
  await bot.stop();
});

it('sem o token, o bot não sobe e aponta a variável', async () => {
  const subida = createTestBot({
    plugins: [avisos],
    http: createHttp({ port: 0, hostname: '127.0.0.1' }),
    env: { BRIDGER_AVISOS__CHAT: 'grupo@g.us' },
  });

  await expect(subida).rejects.toThrow(PluginBootError);
  await expect(subida).rejects.toThrow(/token/);
});
