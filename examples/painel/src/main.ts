// #region main
import { randomBytes } from 'node:crypto';
import { createBot, createHttp } from '@usebridger/core';
import { sqlite } from '@usebridger/storage-sqlite';
import { baileys } from '@usebridger/transport-baileys';
import { painel } from './painel.ts';

// Token do primeiro acesso: só vale enquanto não há usuário. Aqui ele é novo a cada execução e
// sai no terminal; num app de verdade, venha de uma variável de ambiente ou de um cofre.
const bootstrapToken = randomBytes(24).toString('base64url');

const bot = createBot({
  // Sem `pairing`, o baileys pareia por QR, e o QR vai para a API (stream /api/events).
  transport: baileys(),
  // Guarda a sessão do WhatsApp e os usuários e chaves da API.
  storage: sqlite({ path: 'data/painel.sqlite' }),
  http: createHttp({ port: 3000, hostname: '127.0.0.1' }),
  api: { auth: { bootstrapToken } },
  plugins: [painel],
});

await bot.start();
console.log('Abra http://localhost:3000/plugins/painel');
console.log(`Token de primeiro acesso (só antes do primeiro usuário): ${bootstrapToken}`);
// #endregion main
