import { createBot } from '@usebridger/core';
import { pareamento } from '@usebridger/example-primeiro-bot/pareamento';
import { ping } from '@usebridger/example-primeiro-bot/ping';
import { sqlite } from '@usebridger/storage-sqlite';
import { baileys } from '@usebridger/transport-baileys';
import { ola } from './index.ts';

// #region plugar
// O bot do passo anterior, com o plugin novo na lista. Um plugin publicado no npm entra igual:
// `import { ola } from 'bridger-plugin-ola'`.
// Sem argumento, pareia por QR. Com um número (`pnpm start 5511999999999`), por código.
const phone = process.argv[2];

const bot = createBot({
  transport: baileys({ pairing: phone ? { phone } : 'qr' }),
  storage: sqlite({ path: 'data/bot.sqlite' }),
  plugins: [pareamento, ping, ola],
});

await bot.start();
// #endregion plugar
