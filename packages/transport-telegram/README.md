# @usebridger/transport-telegram

Transport do [Bridger](https://www.npmjs.com/package/@usebridger/core) para o Telegram, sobre a
Bot API (pelo [grammY](https://grammy.dev)). Recebe por long polling: não precisa de URL pública.

```sh
npm install @usebridger/transport-telegram
```

```ts
import { createBot } from '@usebridger/core';
import { telegram } from '@usebridger/transport-telegram';

const bot = createBot({
  transport: telegram({ token: process.env.TELEGRAM_TOKEN ?? '' }),
  prefix: '/',
  plugins: [],
});
await bot.start();
```

Requer Node 24 ou mais novo.

- [Documentação](https://github.com/murillous/usebridger/blob/main/packages/transport-telegram/docs/README.md)

Licença [Apache-2.0](https://github.com/murillous/usebridger/blob/main/LICENSE).
