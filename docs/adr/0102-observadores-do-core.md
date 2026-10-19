# ADR 0102 — Observadores do core e `ctx.stats()`

**Status:** Aceito (2026-10-17) · Detalha **D11** ([ADR 0011](0011-escopo-do-core.md)) · Usado
pelo **D103** ([ADR 0103](0103-plugins-oficiais-de-metricas-e-dashboard.md))

## Contexto

Para medir vazão, latência e saúde da fila, um plugin precisa de dois dados que o core tem e não
entrega: os contadores das filas (`bot.stats()`, `bot/bot.ts:662`), que só o app lê, e o desfecho
de cada unidade de trabalho com a duração dela. O evento `command` não traz duração
(`bot/inbound-flow.ts:172`) e não há sinal de envio.

Os mecanismos existentes não servem para um sinal por mensagem:

- **Bus de eventos.** O listener é aguardado e segura o chat (ADR 0038, ADR 0045).
- **Ponto de extensão** (ADR 0092). O `list()` copia, ordena e mapeia a cada chamada
  (`services/registry.ts:93-101`).
- **`node:diagnostics_channel`.** No Node 24, a exceção de um subscriber vira `uncaughtException`
  assíncrona e derruba o processo. O canal é global (`channel(nome)` devolve o mesmo objeto): com
  dois `Bot` no processo um observa o outro, e a assinatura sobrevive ao reload do plugin.

Alternativas consideradas:

- **Só `durationMs` no `CommandEvent`.** Não cobre a fila de saída, mensagens fora de comando nem
  a latência ponta a ponta.
- **Baldes de histograma dentro das filas.** Congela no core os limites dos baldes, que são
  escolha de quem agrega.
- **`AsyncLocalStorage` com o id da mensagem até o plugin.** Rodaria `TenantScope.run` por
  mensagem sem demanda; o `replyTo` cobre a latência ponta a ponta.
- **API ou SDK do OpenTelemetry no core.** Dependência e superfície fora do escopo do core.

## Decisão

- **`ctx.stats()`** no contexto do plugin, o mesmo `BotStats` de `bot.stats()`, lido sob demanda.
- **`ctx.observe(sinal, fn)`**: registro de observadores por `Bot`, síncrono e nunca aguardado.
  Cada chamada roda em `try/catch`, e a exceção vira `plugin.error` com `phase: 'observer'`. A
  assinatura sai no dispose do plugin. Sem observador, o core só compara o tamanho da lista: não
  lê o relógio nem monta o sinal.
- **Dois sinais**, com a duração crua:
  - `message.handled`: `messageId`, `chatId`, `senderId`, `chatType`, `route` (`command`, `step`,
    `message`), `command` (nome canônico), `status`, `queuedMs` (espera na fila de entrada) e
    `durationMs` (handler).
  - `outbound.sent`: `chatId`, `chatType`, `kind`, `status`, `queuedMs` (fila de saída, inclusive
    taxa e re-tentativas), `retries` e `replyTo`. `chatType` é opcional: vem do `createReply`,
    pela mesma chave do `replyTo`, porque o `ctx.send` direto só recebe o id do chat.
- **`replyTo` por uma chave `Symbol` interna**, preenchida pelo `createReply` e retirada pela fila
  antes do transport. O campo não entra em `OutboundSendOptions`, que é público: um plugin poderia
  forjá-lo, e a fila repassa ao transport o que não for `priority`.
- **`queuedMs` medido no `enqueue` de `bot/transport-entry.ts`**, na closure da tarefa. A
  `InboundQueue` continua genérica. O `message.timestamp` não serve, porque vem do relógio da
  plataforma.
- **Relógio monotônico** (`performance.now`), o mesmo da fila de saída.
- Os ids existem só em memória, como no evento `message`. O core não persiste nem exporta nada.

## Consequências

- API pública nova: sinal ou campo novo é minor; mudar ou remover campo é major.
- O bench do ADR 0027 passa a rodar com zero observadores e com um observador vazio. A regressão
  tem de ficar abaixo do ruído do bench intercalado (ADR 0085).
- A latência ponta a ponta cobre só as respostas por `ctx.reply`. `ctx.send` direto e
  `ReplyOrigin` sem `key` saem sem `replyTo`. O `ctx.send` direto também sai sem `chatType`: quem
  agrega por tipo de chat conta esses envios à parte.
- Um adaptador para APM sobre `diagnostics_channel` pode vir depois como plugin, assinando
  `ctx.observe`.
