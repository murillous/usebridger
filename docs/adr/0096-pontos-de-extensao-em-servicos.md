# ADR 0096 — Pontos de extensão em serviços

**Status:** Aceito (2026-10-13) · Detalha **D18** ([ADR 0018](0018-service-registry.md)) e
**D41** ([ADR 0041](0041-reload-em-cascata.md))

## Contexto

Um serviço que outros plugins estendem precisa guardar as contribuições e tirá-las quando o
plugin que contribuiu sai. No LumaBot, o `sticker` aceita etapas e o `sticker-text` acrescenta a
legenda; como o `ServiceAccess` só tinha `provide`/`get`/`has`, o serviço recebeu o `ctx.signal`
de quem contribui e removia a etapa no `abort` (#83). Funciona, mas cada serviço extensível
reimplementa esse ciclo de vida, e o serviço que esquece o `signal` deixa a etapa rodando
duplicada depois do reload do contribuidor, ou depois de ele ter sido desligado.

O registry já atribui cada serviço ao plugin que o proveu e o remove no `dispose` do contexto
(teardown, reload, disable). Falta o mesmo para contribuições.

Alternativas consideradas: o serviço com `ctx.signal` (o que o LumaBot faz), que depende de
disciplina; `contribute` devolvendo `Unsubscribe`, que passa ao contribuidor guardar estado e
lembrar do `teardown`; um plugin utilitário, que não tem como atribuir a contribuição ao plugin
nem ver o ciclo de vida dele; ponto com dono (`declare` por quem oferece), que exigiria decidir o
que acontece com as contribuições quando o dono sai e ordenar o `contribute` depois do `declare`.

## Decisão

- `ctx.services` ganha `contribute(name, contribution)` e `extensionPoint(name)`. A contribuição
  fica atribuída ao plugin dono do contexto; o `removePlugin` do registry, que o `dispose` já
  chama, a tira junto dos serviços.
- `extensionPoint(name)` devolve uma visão viva, `{ list() }`: cada `list()` é uma cópia com as
  contribuições do momento. Quem oferece guarda a visão no `setup` e não guarda contribuições.
- Tipagem por declaration merging numa interface nova, `ExtensionPoints` (nome → tipo de cada
  contribuição), separada de `Services`: um nome pode ser serviço e ponto ao mesmo tempo.
- O ponto não tem dono: `contribute` não exige que alguém tenha pedido o ponto, e o reload de quem
  o oferece não apaga as contribuições dos outros. Vários plugins contribuem ao mesmo ponto, sem
  conflito.
- Ordem: a de carga de quem contribuiu (portanto `after`/`priority`/`dependsOn`, como a carga) e,
  no mesmo plugin, a dos `contribute`. O `Bot` informa ao registry a tabela do host, então o
  plugin recarregado ou religado volta à posição dele, e não ao fim.
- Depois do descarte do contexto, `contribute` lança `PluginHostStateError`, como `provide`.

## Consequências

- O autor do serviço só lê `list()`; reload e disable do contribuidor não duplicam nem deixam
  etapa órfã. O caso do LumaBot passa a não precisar do `ctx.signal` no serviço.
- `ServiceAccess` ganha dois métodos: quem implementa a interface fora do core (um fake de teste)
  precisa acrescentá-los. Os pontos de entrada exportam `ExtensionPoint`, `ExtensionPointName` e
  `ExtensionPoints`.
- A contribuição não sabe de tenant nem de chat: é estado do bot, como o serviço. O que for de um
  cliente continua no `ctx.storage`.
- Ordem mais fina que a de carga (uma etapa antes de outra do mesmo nível) fica para quando um
  caso pedir; hoje `after`/`priority` no manifesto resolvem.
