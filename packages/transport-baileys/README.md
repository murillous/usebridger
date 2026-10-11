# @usebridger/transport-baileys

Transport do [Bridger](https://www.npmjs.com/package/@usebridger/core) para o WhatsApp, sobre o
[Baileys](https://github.com/WhiskeySockets/Baileys).

```sh
npm install @usebridger/transport-baileys
```

```ts
import { createBot } from '@usebridger/core';
import { sqlite } from '@usebridger/storage-sqlite';
import { baileys } from '@usebridger/transport-baileys';

const bot = createBot({
  transport: baileys(), // pareia por QR, que chega aos plugins no evento connection.qr
  storage: sqlite({ path: 'data/bot.sqlite' }), // guarda as credenciais da sessão
  plugins: [],
});
await bot.start();
```

Requer Node 24 ou mais novo.

- [Documentação](https://github.com/murillous/usebridger/blob/main/packages/transport-baileys/docs/README.md)

Licença [Apache-2.0](https://github.com/murillous/usebridger/blob/main/LICENSE).
