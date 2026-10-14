# ADR 0094 — `accepts` estreita o contexto do `run` e ganha `'args'`

**Status:** Aceito (2026-10-12) · Detalha **D12** ([ADR 0012](0012-pipeline-de-3-estagios.md))

## Contexto

Migrando o plugin `media` do LumaBot para o 0.3 (#68), o `accepts` tirou a escolha manual da mídia,
mas deixou duas checagens no `run`:

- Com `accepts: ['sticker', 'quoted:sticker']`, o roteador só roda o `run` se uma entrada casou, e
  as duas têm mídia. O tipo não sabia disso: `ctx.media` seguia `Media | null`, e o plugin cobria
  com um `throw` em runtime.
- O `!sticker` aceita mídia ou um link, e o `!mergepdf`, PDF ou `done`/`clear`. Os dois punham
  `'text'` por último, mas o comando é texto, então `'text'` casava sempre: o `onReject` nunca
  disparava e o uso voltava a ser conferido no `run`.

## Decisão

- `CommandDefinition` e `PluginCommand` ganham o parâmetro do `accepts` declarado. `command()` e o
  `definePlugin` (por comando de `commands`) o inferem do literal, e quando toda entrada é de tipo
  com mídia (`MediaAcceptSpec`), o `run` recebe `MediaCommandContext`: `media: Media` e
  `accepted: AcceptedMessage`. Sem `accepts`, ou com uma entrada sem mídia, fica o
  `CommandContext`. O `onReject` não muda: nele ainda não há mídia.
- Entrada nova `'args'`: casa quando há texto depois do comando (`rawArgs` não vazio), na própria
  mensagem. `'quoted:args'` e `'args'` com mimetype falham na definição.
- `'text'` mantém o sentido de hoje (o tipo da mensagem é texto).

## Alternativas

- **`'text'` passar a exigir argumentos.** Muda em silêncio quem já usa `'text'` para "comando sem
  anexo", e mistura o tipo da mensagem com o conteúdo depois do comando.
- **Padrão no texto (`'text:https://*'`, regex).** O plugin já valida o link no `run` para
  baixá-lo; um padrão no `accepts` duplicaria a regra sem um caso que o peça agora. Pode vir depois
  sobre o `'args'`.
- **Estreitar também o `ctx.commands.add`.** A assinatura genérica não casa com a implementação
  larga do registro; `ctx.commands.add(command({ ... }))` já estreita.

## Consequências

- O `run` de comando de mídia usa `ctx.media` direto, e o uso errado (`!s` sem mídia nem argumento)
  sai pelo `onReject`, num lugar só.
- O estreitamento depende do literal: `accepts` numa variável tipada `AcceptSpec[]` volta ao
  contexto largo, o que a doc de comandos registra.
- O `command()` devolve o `CommandDefinition` largo com um cast: o `run` estreito só recebe o
  contexto que o roteador monta para aquele `accepts`.
