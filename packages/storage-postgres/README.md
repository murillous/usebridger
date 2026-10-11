# @usebridger/storage-postgres

Storage do [Bridger](https://www.npmjs.com/package/@usebridger/core) em Postgres, para vários
processos (ou máquinas) dividindo o mesmo banco.

```sh
npm install @usebridger/storage-postgres
```

```ts
import { createBot } from '@usebridger/core';
import { postgres } from '@usebridger/storage-postgres';
import { baileys } from '@usebridger/transport-baileys';

const bot = createBot({
  transport: baileys(),
  storage: await postgres({ connectionString: 'postgres://bot:senha@db:5432/bot' }),
  plugins: [],
});
await bot.start();
```

Requer Node 24 ou mais novo.

- [Documentação](https://github.com/murillous/usebridger/blob/main/packages/storage-postgres/docs/README.md)

Licença [Apache-2.0](https://github.com/murillous/usebridger/blob/main/LICENSE).
