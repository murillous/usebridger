# @usebridger/plugin-metrics

Plugin oficial do [Bridger](https://www.npmjs.com/package/@usebridger/core): o serviço `metrics`
(contadores, histogramas e gauges declarados sobre o `prom-client`), o histórico por hora e dia
no storage do bot e o `GET /metrics`.

```sh
npm install @usebridger/plugin-metrics
```

```ts
import { createBot } from '@usebridger/core';
import { metrics } from '@usebridger/plugin-metrics';

const bot = createBot({ transport, storage, plugins: [metrics, meuPlugin] });

// no plugin que declara dependsOn: { metrics: '*' }
const m = ctx.services.get('metrics');
const tokens = m.counter({ name: 'ai_tokens_total', help: 'Tokens', labelNames: ['model', 'kind'] });
tokens.inc({ model, kind: 'input' }, usage.inputTokens);
```

- [Documentação](https://github.com/murillous/usebridger/blob/main/packages/plugin-metrics/docs/README.md)

Licença [Apache-2.0](https://github.com/murillous/usebridger/blob/main/LICENSE).
