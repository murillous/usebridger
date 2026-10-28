# @usebridger/plugin-dashboard

Plugin oficial do [Bridger](https://www.npmjs.com/package/@usebridger/core): app web (em
`/plugins/dashboard/`) sobre a API HTTP do core, com login, conexão e QR ao vivo, logs, plugins e
config, métricas, auditoria, usuários, API keys e uma tela genérica para os recursos dos plugins.

```sh
npm install @usebridger/plugin-dashboard
```

```ts
import { createHttp, createBot } from '@usebridger/core';
import { dashboard } from '@usebridger/plugin-dashboard';

const bot = createBot({
  transport,
  storage,
  http: createHttp({ port: 3000 }),
  api: { auth: { bootstrapToken: appEnv.BRIDGER_BOOTSTRAP_TOKEN } },
  plugins: [dashboard],
});
```

- [Documentação](https://github.com/murillous/usebridger/blob/main/packages/plugin-dashboard/docs/README.md)

Licença [Apache-2.0](https://github.com/murillous/usebridger/blob/main/LICENSE).
