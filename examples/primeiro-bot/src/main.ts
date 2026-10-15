// #region bot
import { createBot } from '@usebridger/core';
import { sqlite } from '@usebridger/storage-sqlite';
import { baileys } from '@usebridger/transport-baileys';
import { pareamento } from './pareamento.ts';
import { ping } from './ping.ts';

// Sem argumento, pareia por QR. Com um número (`pnpm start 5511999999999`), por código.
const phone = process.argv[2];

const bot = createBot({
  transport: baileys({ pairing: phone ? { phone } : 'qr' }),
  // As credenciais do WhatsApp ficam aqui: depois do primeiro pareamento não pede QR de novo.
  storage: sqlite({ path: 'data/bot.sqlite' }),
  plugins: [pareamento, ping],
});

await bot.start();
// #endregion bot
