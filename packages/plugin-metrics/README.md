# @usebridger/plugin-metrics

Plugin oficial do [Bridger](https://www.npmjs.com/package/@usebridger/core): o serviço `metrics`
(contadores e histogramas), agregado em memória e persistido por dia no storage do bot.

```sh
npm install @usebridger/plugin-metrics
```

```ts
import { metrics } from '@usebridger/plugin-metrics';

const bot = createBot({ transport, storage, plugins: [metrics, meuPlugin] });

// no plugin que declara dependsOn: { metrics: '*' }
const m = ctx.services.get('metrics');
m.counter('ai.tokens', { model, kind: 'input' }, usage.inputTokens);
m.observe('ai.latency', { model, ok: 'true' }, durationMs);
const linhas = await m.query('ai.tokens', { from: '2026-10-01', to: '2026-10-17' });
```

- [Documentação](https://github.com/murillous/usebridger/blob/main/packages/plugin-metrics/docs/README.md)

Licença [Apache-2.0](https://github.com/murillous/usebridger/blob/main/LICENSE).
