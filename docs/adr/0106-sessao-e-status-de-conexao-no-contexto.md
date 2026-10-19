# ADR 0106 — Sessão e último status de conexão no contexto do plugin

**Status:** Aceito (2026-10-17) · Detalha **D103** ([ADR 0103](0103-plugins-oficiais-de-metricas-e-dashboard.md)) ·
Usado pelo dashboard (**D104**, [ADR 0104](0104-abas-do-dashboard-por-ponto-de-extensao.md))

## Contexto

O dashboard roda por bot (ADR 0104); com vários bots no processo, a tela precisa saber de qual
sessão é o status, e o `ctx` do plugin não expunha o nome da sessão. Além disso, o core não
guardava o último `ConnectionStatus`: um plugin carregado depois do boot, ou recarregado, ficava
em `connecting` até o próximo evento, que numa conexão estável pode nunca vir.

Alternativa descartada: o plugin reconstruir o estado só pelo barramento. Não resolve o reload,
porque o evento que importa já passou.

## Decisão

- **`ctx.session`**: `string` readonly, o nome da sessão do bot (`default` sem config).
- **`ctx.connectionStatus()`**: devolve o último `ConnectionStatus` que o transport emitiu, ou
  `undefined` antes do primeiro evento. O core o guarda por `Bot`, no mesmo ponto em que
  reemite `connection.status` no barramento (`transport-entry`), então snapshot e evento não
  divergem.
- O `plugin-dashboard` parte desse snapshot no `setup` (mesma regra que aplica o evento) e
  inclui `session` no `StatusView` (`GET /api/status` e snapshot do WS).
- QR e código de pareamento não entram no snapshot do core: são transitórios, valem pouco e o
  QR é sensível. Quem os exibe continua assinando os eventos.

## Consequências

- Campo e método novos no `PluginContext` são minor. Implementar o contexto fora do core
  (mocks) passa a exigir os dois.
- Custo: uma referência por bot, atualizada a cada `connection.status`.
