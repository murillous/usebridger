# @usebridger/storage-sqlite

Storage padrão do [Bridger](https://www.npmjs.com/package/@usebridger/core), sobre o SQLite que
vem no próprio Node (`node:sqlite`), sem dependência nativa.

```sh
npm install @usebridger/storage-sqlite
```

```ts
import { createBot } from '@usebridger/core';
import { sqlite } from '@usebridger/storage-sqlite';
import { baileys } from '@usebridger/transport-baileys';

const bot = createBot({
  transport: baileys(),
  storage: sqlite({ path: 'data/bot.sqlite' }), // dados dos plugins e credenciais do WhatsApp
  plugins: [],
});
await bot.start();
```

Requer Node 24 ou mais novo.

- [Documentação](https://github.com/murillous/usebridger/blob/main/packages/storage-sqlite/docs/README.md)

Licença [Apache-2.0](https://github.com/murillous/usebridger/blob/main/LICENSE).
