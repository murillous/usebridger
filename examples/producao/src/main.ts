import { createBot, createHttp } from '@usebridger/core';
import { avisos } from '@usebridger/example-configuracao/avisos';
import { pareamento } from '@usebridger/example-primeiro-bot/pareamento';
import { ping } from '@usebridger/example-primeiro-bot/ping';
import { sqlite } from '@usebridger/storage-sqlite';
import { baileys } from '@usebridger/transport-baileys';

// #region main
// Sem argumento, pareia por QR. Com um número (`node src/main.ts 5511999999999`), por código,
// que é mais fácil de ler num log de servidor do que um QR.
const phone = process.argv[2];

const bot = createBot({
  transport: baileys({ pairing: phone ? { phone } : 'qr' }),
  // Fora da pasta do código: o volume do Docker ou a pasta que entra no backup.
  storage: sqlite({ path: 'data/bot.sqlite' }),
  // Com ao menos uma rota de plugin (a do `avisos`), a porta abre e responde também `/health`.
  http: createHttp({ port: 3000 }),
  plugins: [pareamento, ping, avisos],
  // Uma linha JSON por evento no stdout, que o supervisor guarda e o agregador lê.
  logLevel: 'info',
});

// O core não trata sinal: quem decide sair é o app. O `stop()` termina o que está nas filas,
// fecha a conexão e o storage, e só então o processo sai.
for (const sinal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sinal, () => {
    bot.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error(error);
        process.exit(1);
      },
    );
  });
}

await bot.start();
// #endregion main
