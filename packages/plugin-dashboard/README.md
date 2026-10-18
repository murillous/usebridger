# @usebridger/plugin-dashboard

Plugin oficial do [Bridger](https://www.npmjs.com/package/@usebridger/core): Dashboard com
autenticação por token, status da conexão, QR, logs ao vivo, controle de plugins e config, e o app
web que serve tudo isso (em `/plugins/dashboard/`).

```sh
npm install @usebridger/plugin-dashboard
```

```ts
import { createHttp, createBot } from '@usebridger/core';
import { dashboard } from '@usebridger/plugin-dashboard';

const bot = createBot({
  transport,
  http: createHttp({ port: 3000 }),
  plugins: [dashboard],
  pluginConfig: { dashboard: { token: process.env.DASHBOARD_TOKEN } },
});
```

- [Documentação](https://github.com/murillous/usebridger/blob/main/packages/plugin-dashboard/docs/README.md)

Licença [Apache-2.0](https://github.com/murillous/usebridger/blob/main/LICENSE).
