import { createHttp } from '@usebridger/core';
import { createTestBot, type TestBot } from '@usebridger/testing';
import { afterEach, expect, it } from 'vitest';
import { painel } from './painel.ts';

const bootstrapToken = 'token-de-primeiro-acesso-do-teste';
let bot: TestBot | undefined;
afterEach(async () => {
  await bot?.bot.stop();
  bot = undefined;
});

// Lê o stream SSE até chegar um evento do tipo pedido e devolve o `data` dele.
async function nextEvent(res: Response, type: string): Promise<unknown> {
  const reader = (res.body as ReadableStream<Uint8Array>)
    .pipeThrough(new TextDecoderStream())
    .getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`stream fechou antes de ${type}`);
    buffer += value;
    for (const block of buffer.split('\n\n')) {
      const lines = block.split('\n');
      if (lines.includes(`event: ${type}`)) {
        await reader.cancel();
        return JSON.parse(lines.find((l) => l.startsWith('data: '))?.slice(6) ?? 'null');
      }
    }
  }
}

// O caminho que a página faz, chamada a chamada: serve o HTML, recusa sem sessão, cria o owner com
// o token de primeiro acesso, lê quem entrou e a conexão, e recebe o QR pelo stream.
it('a página e as rotas da API que ela usa funcionam de ponta a ponta', async () => {
  const http = createHttp({ port: 0, hostname: '127.0.0.1' });
  bot = await createTestBot({ plugins: [painel], http, api: { auth: { bootstrapToken } } });
  const base = `http://127.0.0.1:${http.port}`;

  const pagina = await fetch(`${base}/plugins/painel`);
  expect(pagina.headers.get('content-type')).toContain('text/html');
  const html = await pagina.text();
  for (const rota of [
    '/auth/me',
    '/auth/login',
    '/auth/invites/accept',
    '/connection',
    '/events',
  ]) {
    expect(html).toContain(`'${rota}`);
  }

  expect((await fetch(`${base}/api/auth/me`)).status).toBe(401);

  const aceite = await fetch(`${base}/api/auth/invites/accept`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bridger-csrf': '1' },
    body: JSON.stringify({
      token: bootstrapToken,
      name: 'Dona',
      email: 'dona@exemplo.com',
      password: 'uma senha longa',
    }),
  });
  expect(aceite.status).toBe(200);
  const cookie = (aceite.headers.get('set-cookie') ?? '').split(';')[0] as string;
  expect(cookie).toMatch(/^bridger_session=/);
  const headers = { cookie };

  const me = (await (await fetch(`${base}/api/auth/me`, { headers })).json()) as {
    name: string;
    role: string;
    permissions: string[];
  };
  expect(me).toMatchObject({ name: 'Dona', role: 'owner' });
  expect(me.permissions).toContain('connection.manage');

  const conexao = await fetch(`${base}/api/connection`, { headers });
  expect(await conexao.json()).toMatchObject({ status: 'open' });

  const stream = await fetch(`${base}/api/events?types=connection.status,connection.qr`, {
    headers,
  });
  expect(stream.headers.get('content-type')).toContain('text/event-stream');
  const qr = nextEvent(stream, 'connection.qr');
  bot.transport.emit('connection.qr', { qr: 'qr-de-teste' });
  expect(await qr).toMatchObject({ qr: 'qr-de-teste' });
});
