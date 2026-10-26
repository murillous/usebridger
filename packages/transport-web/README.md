# @usebridger/transport-web

Transport do [Bridger](https://www.npmjs.com/package/@usebridger/core) para o chatbot dentro de
um sistema web próprio: o sistema emite um JWT para o widget, e o widget conversa com o bot por
WebSocket. Conversas e mídia vão por HTTP.

```sh
npm install @usebridger/transport-web
```

```ts
import { createBot, createHttp } from '@usebridger/core';
import { web } from '@usebridger/transport-web';

// Para expor publicamente, configure `api.auth`, ou fique em loopback atrás de proxy reverso.
const bot = createBot({
  transport: web({ auth: { jwksUrl: 'https://erp.exemplo.com/.well-known/jwks.json' } }),
  http: createHttp({ port: 3000, hostname: '127.0.0.1' }),
  prefix: '', // no web, o comando pode vir sem prefixo
  plugins: [],
});
await bot.start();
```

Requer Node 24 ou mais novo.

- [Documentação](https://github.com/murillous/usebridger/blob/main/packages/transport-web/docs/README.md)

Licença [Apache-2.0](https://github.com/murillous/usebridger/blob/main/LICENSE).
