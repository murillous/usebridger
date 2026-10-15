import { randomBytes } from 'node:crypto';
import { createBot, createHttp } from '@usebridger/core';
import { ping } from '@usebridger/example-primeiro-bot/ping';
import { web } from '@usebridger/transport-web';
import { pagina } from './pagina.ts';

// #region bot
// Segredo do JWT (mínimo de 32 bytes), novo a cada execução: serve para o exemplo.
const secret = randomBytes(32).toString('hex');

const bot = createBot({
  // O transport web recebe as conexões pelo servidor HTTP do bot.
  http: createHttp({ port: 3000 }),
  transport: web({ auth: { secret } }),
  plugins: [ping, pagina(secret)],
});

await bot.start();
console.log('Abra http://localhost:3000/plugins/pagina e digite !ping');
// #endregion bot
