# ADR 0093 — `onExpire` no passo: reagir à espera que venceu

**Status:** Aceito (2026-10-13) · Detalha **D56** ([ADR 0056](0056-resposta-esperada.md)), com
**D29** ([ADR 0029](0029-cancelamento-cooperativo.md)) e **D38**
([ADR 0038](0038-handler-lento-segura-o-chat.md))

## Contexto

O `expectReply` expira em silêncio (ADR 0056). Passado o `ttlMs`, a espera some e o plugin não
fica sabendo. Em conversa guiada isso pede reação: "Ainda está aí? Vou encerrar o atendimento",
lembrar de terminar um cadastro, registrar o abandono de um funil (#89).

Hoje o plugin contorna com um job próprio (`ctx.scheduler`) espelhando o TTL. Ele não sabe se a
espera foi respondida, trocada por outra (de qualquer plugin), cancelada por um comando ou
descartada no reload, e erra nos dois sentidos. Só o kernel sabe por que a espera acabou. O ADR
0056 deixou o `onExpire` de fora por falta de caso e registrou que ele entraria depois sem quebrar
a API.

Em paralelo, a #90 leva as esperas ao storage. Uma espera restaurada no boot pode já ter vencido
durante o restart.

Alternativas consideradas:

- **Job no plugin com `ctx.scheduler`.** Duplica o TTL e não sabe por que a espera acabou.
- **Evento no barramento (`conversation.expired`).** O passo é do plugin e só o dono reage. Um
  handler ao lado do `define` mantém a coesão e evita filtrar por plugin em todo listener.
- **Rodar o `onExpire` direto no timer, fora da fila do chat.** Correria junto com uma mensagem do
  mesmo chat, e quem guarda estado por conversa perderia a ordem que o ADR 0038 garante.
- **Retirar a espera no timer e só depois enfileirar o `onExpire`.** A resposta que já estava na
  fila atrás de uma mensagem lenta chegaria ao passo depois do vencimento e cairia no fluxo
  normal, embora a pessoa tenha respondido a tempo do ponto de vista dela.
- **Erro do `onExpire` como `phase: 'step'` com um marcador.** Obrigaria quem observa a separar
  pelo erro. Uma fase própria se filtra direto.
- **`onExpire` também no teardown, reload ou `stop()`.** Não é abandono da pessoa, é o bot
  descendo. O `onExpire` mandaria "encerrei por falta de resposta" a cada deploy.
- **Espera restaurada já vencida expira em silêncio.** O plugin perderia exatamente os abandonos
  que aconteceram com o bot fora do ar, sem jeito de saber deles.

## Decisão

- **API.** `ctx.conversations.define(step, handler, { onExpire })`. O terceiro argumento é
  opcional. Um `onExpire` que não é função lança `TypeError` no `define`, como o nome inválido.
  Passo sem `onExpire` continua expirando em silêncio, sem custo novo.
- **Quando dispara.** Só quando o TTL vence. Não dispara quando a espera é respondida, trocada por
  outro `expectReply` (do mesmo plugin ou de outro), descartada porque o texto casou um comando ou
  pelo clique num botão ou comando nativo, nem quando é removida por teardown, reload ou `stop()`.
  Uma espera que vence durante o `stop()` também some em silêncio.
- **Onde roda.** O timer não retira a espera: ele marca a espera como vencida e põe uma tarefa na
  **fila do chat**, no escopo do tenant do chat (ADR 0068), como uma mensagem. Na vez dela, a
  tarefa retira a espera e roda o `onExpire`. Assim o `onExpire` nunca corre junto com uma
  mensagem do mesmo chat, e **quem entra primeiro na fila decide**: a resposta que já estava na
  fila vai ao passo, e a tarefa não acha mais o que expirar. Se a tarefa entrou primeiro, o
  `onExpire` roda e a resposta segue o fluxo normal. A espera é retirada uma vez só. A tarefa
  espera o fim do boot, como a mensagem, e não passa pelos middlewares, porque não há mensagem.
- **Retirada só da espera vencida.** A tarefa só retira a espera se ela ainda for vencida (marcada
  pelo timer, ou com o vencimento no passado). Uma espera nova, aberta entre o vencimento e a vez
  da tarefa (por um comando em segundo plano, ADR 0083), fica.
- **Fila do chat cheia ou fechada.** A tarefa não entra (`'full'` ou `'closed'`). A espera vencida
  é retirada em silêncio, com uma linha `warn` para a fila cheia, e o `onExpire` não roda. Deixá-la
  no registro a manteria para sempre, sem timer.
- **Prazo.** O do comando (`timeouts.commandMs`), como o passo: um `onExpire` preso seguraria o
  chat. Tem um `Deadline` próprio, filho do de vida do plugin (ADR 0029): o reload aborta o
  `signal` e recusa os efeitos de um `onExpire` ainda rodando. Estourado o prazo, o `signal`
  aborta com `StepTimeoutError`, que ganha `stage: 'run' | 'onExpire'`, como o
  `CommandTimeoutError` tem `stage`.
- **Contexto.** `chat`, `sender` (quem não respondeu), `step`, `data`, `reply`, `log` (com o
  `chatId`), `t`, `signal` e `expectReply`. Não há `message`, `text` nem `react`. O `reply` envia
  no chat da espera, sem citar, com prioridade `high` e as ações de passo em nome do plugin, como o
  do passo. O `expectReply` abre outra espera para a mesma pessoa no mesmo chat ("Ainda está
  aí?"). Depois do prazo ou do descarte do plugin, `reply` e `expectReply` recusam com
  `ContextExpiredError`, como no passo.
- **Erro.** Falha ou prazo estourado vira `plugin.error` com a fase nova **`'step-expire'`**,
  `event` = nome do passo e `timedOut` quando o erro é `StepTimeoutError`. A rejeição depois do
  prazo vai só ao log, como no passo.
- **`settled()`.** A tarefa da expiração conta enquanto está na fila ou rodando, porque é tarefa da
  fila do chat. O TTL pendente continua não contando.
- **Ponto único de expiração.** Toda expiração passa por um caminho só: o timer chama o `onDue` do
  `ConversationRegistry`, que no bot é `expireWait(chat, sender)`. Ele enfileira a tarefa, que
  chama `ConversationRegistry.expire(chatId, senderId)`. É o `expire` que retira a espera vencida e
  devolve o `onExpire` a rodar.
- **Esperas persistidas (#90).** Uma espera restaurada no boot que **já venceu durante o restart
  dispara o `onExpire`**. A restauração a devolve ao registro e chama o mesmo `expireWait(chat,
  sender)`. Como a espera guarda o vencimento (`dueAt`), o `expire` a reconhece como vencida sem
  depender do timer. A tarefa espera o fim do boot, então o `onExpire` só roda com os plugins de
  pé.

## Consequências

- Mudança aditiva no `Conversations.define` (terceiro argumento) e no `StepTimeoutError`
  (`stage`). O `PluginErrorEvent.phase` ganha `'step-expire'`. Quem faz `switch` exaustivo sobre a
  fase precisa tratar o valor novo.
- Os tipos `ExpireContext`, `ExpireHandler` e `StepOptions` ficam fora do índice do pacote por
  ora: a lista da API pública só muda por decisão explícita (ADR 0030). O handler é inferido pelo
  `define`.
- A espera passa a guardar o `Chat` e o `Contact` de origem e o vencimento, o que o `onExpire` usa
  para responder e a #90 usa para persistir.
- Custo: nenhum no caminho da mensagem. Uma espera vencida com `onExpire` ocupa uma tarefa na fila
  do chat. Sem `onExpire`, a expiração continua só tirando a espera do mapa.
- O `onExpire` vê o mundo como o timer o encontra: com a fila do chat cheia ou o bot parando, ele
  não roda. Quem precisa de garantia de entrega do aviso ainda precisa do próprio storage.
- O kit de testes não ganha API: o teste vence a espera com os fake timers do Vitest e espera o
  `bot.settled()`.
