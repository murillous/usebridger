import { createBot, createHttp, createLogger } from '@usebridger/core';
import { web } from '@usebridger/transport-web';
import { connectWebChat } from '@usebridger/transport-web/client';
import { expect, it } from 'vitest';
import { pagina } from './pagina.ts';
import { ping } from './ping.ts';

// Ponta a ponta do que o exemplo traz de próprio: a página serve um token que o transport aceita
// de verdade e o !ping volta como pong pelo WebSocket.
it('o token da página é aceito pelo transport e o !ping responde pong', async () => {
  const secret = 'segredo-de-teste-com-pelo-menos-32-bytes';
  const http = createHttp({ port: 0, hostname: '127.0.0.1' });
  const bot = createBot({
    http,
    transport: web({ auth: { secret } }),
    plugins: [ping, pagina(secret)],
    logger: createLogger({ level: 'silent' }),
  });
  await bot.start();
  try {
    const resposta = await fetch(`http://127.0.0.1:${http.port}/plugins/pagina`);
    expect(resposta.headers.get('content-type')).toContain('text/html');
    const token = /token: '([^']+)'/.exec(await resposta.text())?.[1];
    expect(token).toBeDefined();

    const chat = await connectWebChat({
      url: `ws://127.0.0.1:${http.port}/transports/web/chat`,
      token: token as string,
    });
    const texto = new Promise<string>((resolve) =>
      chat.on('message', (m) => resolve(m.text ?? '')),
    );
    await chat.send('!ping');
    expect(await texto).toBe('pong');
    chat.close();
  } finally {
    await bot.stop();
  }
});
