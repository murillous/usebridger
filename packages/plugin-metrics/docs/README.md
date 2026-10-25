# @usebridger/plugin-metrics — documentação

Plugin oficial que provê o serviço `metrics`, mede o kernel sozinho e expõe o `GET /metrics`
Prometheus ([ADR 0103](../../../docs/adr/0103-plugins-oficiais-de-metricas-e-dashboard.md)). O
serviço é uma camada fina sobre o [`prom-client`](https://github.com/siimon/prom-client), com as
métricas declaradas antes do uso ([ADR 0121](../../../docs/adr/0121-plugin-metrics-sobre-o-prom-client.md)).

Nesta versão o plugin não grava nada no storage: o histórico por hora e dia e a leitura (`query`,
`catalog`) voltam nas próximas versões. O ponto `metrics.exporters` segue declarado, mas ninguém o
chama até o histórico voltar.

## Escrever

Carregue `metrics` no bot e declare `dependsOn: { metrics: '*' }` no plugin que o consome.
Declare as métricas no `setup` e guarde o handle:

```ts
const m = ctx.services.get('metrics'); // tipo MetricsService, vem do import do pacote

const tokens = m.counter({
  name: 'ai_tokens_total',
  help: 'Tokens consumidos',
  labelNames: ['model', 'kind'],
});
const latency = m.histogram({
  name: 'ai_latency_seconds',
  help: 'Latência da chamada ao modelo',
  labelNames: ['model', 'ok'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30], // opcional
});
const queue = m.gauge({ name: 'ai_queue_size', help: 'Pedidos na fila', labelNames: [] });

tokens.inc({ model, kind: 'input' }, usage.inputTokens); // valor padrão 1
latency.observe({ model, ok: 'true' }, durationMs / 1000);
queue.set({}, pending);
```

- O tipo dos rótulos sai do `labelNames`: rótulo não declarado não compila e lança `TypeError`
  em runtime. Rótulo declarado pode faltar na chamada e fica ausente na série.
- O valor precisa ser número finito `>= 0`, senão `TypeError` (o gauge também).
- O valor do rótulo é texto. A ordem das chaves na chamada não cria série nova.

### Regras da declaração

Declaração inválida lança `TypeError`:

- `name` segue `^[a-zA-Z_:][a-zA-Z0-9_:]*$`, com a unidade no nome (`_seconds`, `_bytes`). Tempo
  vai em segundos, a convenção do Prometheus.
- O contador termina em `_total`.
- Os prefixos `process_` e `nodejs_` são reservados ao runtime do Node.
- `help` é texto não vazio.
- `labelNames` segue `^[a-zA-Z_][a-zA-Z0-9_]*$`, sem repetição. Histograma não aceita `le`, o
  rótulo dos baldes.
- `buckets` são finitos e crescentes. Sem `buckets`, vale o padrão do `prom-client`
  (`0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10`).
- Os nomes dos gauges ao vivo do kernel (abaixo) não podem ser declarados.

### Redeclaração e dono

- A mesma especificação (tipo, `help`, `labelNames` na mesma ordem e `buckets`) devolve o mesmo
  handle, também a outro plugin. Especificação diferente para o mesmo nome lança `TypeError`.
- O serviço tem escopo por quem chama ([ADR 0112](../../../docs/adr/0112-servico-com-escopo-por-chamador.md)):
  o dono de uma métrica é o primeiro plugin que a declarou. O que o próprio plugin-metrics declara
  tem o dono `core`.
- Quando um plugin sai (reload ou disable), ele deixa de declarar as métricas dele. Se outro
  plugin declarou a mesma métrica, ela segue no `/metrics` e esse plugin vira o dono. Sem ninguém,
  a métrica sai do `/metrics` e volta zerada na próxima declaração, como no `setup` do reload.

O dono ainda não sai na API pública; ele volta com o `catalog`.

## Dado pessoal

O handle lança `TypeError` quando um valor de rótulo é texto que parece id de chat ou de usuário.
O core não expõe um reconhecedor, então a checagem é por formato: contém `@`
(JID `...@s.whatsapp.net`, `@g.us`, `@lid`), telefone (`+5511...` ou 7+ dígitos) ou id numérico
negativo longo. Um id opaco fora desses formatos passa: quem usa o serviço é quem responde por
não pôr id como rótulo.

A checagem olha só os **valores** dos rótulos, não os nomes. Limites conhecidos:

- Falsos positivos (lançam, mas não são pessoais): data compacta (`20261017`), CEP sem hífen,
  códigos e builds com 7+ dígitos, versões com `@` (`pkg@1.2.3`). Use outra forma (`2026-10-17`,
  `build-1234567`).
- Falsos negativos (passam, mas podem ser pessoais): telefone formatado (`(11) 99999-9999`) e
  ids opacos fora dos formatos acima.

## Limite de séries

Cada combinação de rótulos é uma série. Passado `maxSeriesPerMetric`, a escrita numa série
**nova** é descartada e o plugin registra um `warn` (`metrics.series.overflow`, uma vez por
métrica); as séries que já existem seguem somando. O limite vale para a vida da registry: só
recomeça no restart ou reload do plugin. Rótulo de cardinalidade alta (ids, textos livres) esgota
o limite cedo.

## Config

Pela config do plugin (`pluginConfig.metrics`):

| Campo | Padrão | O que faz |
| --- | --- | --- |
| `maxSeriesPerMetric` | `1000` | Limite de séries por métrica |

## Métricas do kernel

O plugin assina `message.handled` e `outbound.sent` com `ctx.observe`
([ADR 0102](../../../docs/adr/0102-observadores-do-core.md)), com rótulos de baixa cardinalidade e
nunca id de chat ou de usuário:

| Métrica | Tipo | Rótulos |
| --- | --- | --- |
| `bridger_messages_handled_total` | contador | `chatType`, `route`, `status`, `command` (se houver) |
| `bridger_message_handle_duration_seconds` | histograma (`0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30`) | `route`, `status` |
| `bridger_outbound_sent_total` | contador | `kind`, `status`, `chatType` (só em `ctx.reply`) |

Os gauges abaixo são lidos de `ctx.stats()` e do tracker de ativos a cada scrape. Eles ficam na
registry do bot, fora do serviço:

| Gauge | O que mede |
| --- | --- |
| `bridger_inbound_pending` | Tarefas aguardando na fila de entrada |
| `bridger_inbound_active_chats` | Chats com tarefa rodando |
| `bridger_outbound_pending{priority}` | Mensagens aguardando na fila de saída, por prioridade |
| `bridger_outbound_in_flight` | Envios em andamento |
| `bridger_outbound_paused` | `1` com a fila de saída pausada pela conexão caída |
| `bridger_active_users` | Usuários ativos hoje (UTC), desde o início do processo |
| `bridger_active_groups` | Grupos ativos hoje (UTC), desde o início do processo |

Os totais acumulados das filas (`processed`, `failed`, `dropped`...) não são expostos;
`bridger_messages_handled_total` e `bridger_outbound_sent_total` cobrem o volume e o resultado.

### Ativos por dia

Cada mensagem tratada põe o HMAC-SHA256 do id do remetente (e do chat, se grupo) num conjunto em
memória. A chave é aleatória, gerada por dia (UTC), nunca gravada nem logada; na virada a chave
e o conjunto são trocados. Só o tamanho dos conjuntos sai, nos gauges `bridger_active_*`.

**Restart no meio do dia superestima:** o conjunto recomeça vazio e quem já tinha sido contado
conta de novo.

## `GET /metrics`

Registrado no HTTP do core ([ADR 0018](../../../docs/adr/0018-http-unico-hono.md),
[HTTP](../../core/docs/http.md)), sob a base do plugin: `/plugins/metrics/metrics` na sessão
`default` e `/sessions/<sessão>/plugins/metrics/metrics` nas outras. O corpo é o
`registry.metrics()` do `prom-client`, no formato de texto do Prometheus (`content-type` de
`registry.contentType`), com `# HELP` e `# TYPE` de cada métrica. Sem `http` no bot a rota não
existe (`metrics.http.missing`, `info` no log) e o resto do plugin segue.

- Cada bot (e cada `setup` do plugin) tem a sua `Registry`, nunca o `register` global do
  `prom-client`: dois bots no mesmo processo não se enxergam.
- As métricas de outros plugins aparecem também, com o nome declarado.
- `reload`/`restart` do plugin recomeçam a registry e o tracker de ativos: os contadores voltam a
  zero, o que o Prometheus trata como reset de contador, e os ativos do dia superestimam.
- **Sem autenticação** (autenticação é do plugin, `http.md`): os dados não têm id pessoal, mas
  proteja a rota no proxy se a instância é pública.
