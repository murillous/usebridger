import { createBot, createHttp } from '@usebridger/core';
import { pareamento } from '@usebridger/example-primeiro-bot/pareamento';
import { ping } from '@usebridger/example-primeiro-bot/ping';
import { sqlite } from '@usebridger/storage-sqlite';
import { baileys } from '@usebridger/transport-baileys';
import { avisos } from './avisos.ts';

// #region bot
// O que não é segredo pode ficar no código, na camada "arquivo". O `token` vem só do ambiente:
// BRIDGER_AVISOS__TOKEN. O `chat` também pode vir dele (BRIDGER_AVISOS__CHAT), e a env vence.
const bot = createBot({
  transport: baileys({ pairing: 'qr' }),
  storage: sqlite({ path: 'data/bot.sqlite' }),
  // A rota do plugin precisa do servidor HTTP do processo.
  http: createHttp({ port: 3000, hostname: '127.0.0.1' }),
  plugins: [pareamento, ping, avisos],
  pluginConfig: {
    avisos: { chat: '120363000000000000@g.us', prefixo: '🚨' },
  },
});

await bot.start();
// #endregion bot
