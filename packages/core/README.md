# @usebridger/core

Core do Bridger, framework de bots de mensageria extensível por plugins. O core cuida de plugins, comandos,
filas, middlewares e storage; a plataforma (WhatsApp, chat web) entra por um transport.

```sh
npm install @usebridger/core @usebridger/storage-sqlite @usebridger/transport-baileys
```

```ts
import { bold, createBot, definePlugin, fmt } from '@usebridger/core';
import { sqlite } from '@usebridger/storage-sqlite';
import { baileys } from '@usebridger/transport-baileys';

const ola = definePlugin({
  name: 'ola',
  version: '1.0.0',
  engine: '<1.0.0',
  commands: {
    ola: {
      description: 'Cumprimenta quem chamou',
      run: async (c) => fmt`Olá, ${bold(c.message.sender.name ?? 'pessoa')}!`,
    },
  },
});

const bot = createBot({
  transport: baileys(),
  storage: sqlite({ path: 'data/bot.sqlite' }),
  plugins: [ola],
});
await bot.start();
```

Requer Node 24 ou mais novo.

- [Documentação](https://github.com/murillous/usebridger/blob/main/packages/core/docs/README.md)
- [Guias para escrever um plugin](https://github.com/murillous/usebridger/blob/main/docs/guias/README.md)
- [Decisões de arquitetura (ADRs)](https://github.com/murillous/usebridger/blob/main/docs/adr/README.md)

Licença [Apache-2.0](https://github.com/murillous/usebridger/blob/main/LICENSE).
