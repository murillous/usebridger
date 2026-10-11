# ADR 0092 — Placeholders nas `messages` e `ctx.t`

**Status:** Aceito (2026-10-11) · Substitui em parte **D25**
([ADR 0025](0025-sem-i18n-objeto-messages.md)) · Detalha **D63**
([ADR 0063](0063-prefixo-por-chat.md))

## Contexto

As `messages` do D25 são textos fixos, e isso falha em dois casos (#51):

- A ajuda de uso diz `!sticker` mesmo num chat com prefixo trocado (D63). Para acertar, o plugin
  monta a frase com `ctx.prefixes.get(chat)`, e o texto deixa de ser sobrescrevível.
- Texto com valor vira concatenação no plugin (`${m.mergeAdded} (${n}).`, no `!mergepdf` do
  LumaBot). Quem traduz ou ajusta pela config não controla onde o número entra.

O D25 recusou o `ctx.t()` de um i18n completo (catálogos, plurais). Aqui o `t` só preenche
placeholders do mesmo objeto `messages`; catálogo por idioma continua fora.

## Decisão

- **`{nome}` no texto**, só com identificador (`[A-Za-z_][A-Za-z0-9_]*`). Chaves com espaço ou
  pontuação (`{ ok }`, JSON) ficam como texto, sem escape.
- **`t(chave, valores?)`** no contexto de comando, de passo e de listener de mensagem: os que têm
  plugin dono e chat. O `{prefix}` o kernel preenche com o prefixo do chat, lido a cada chamada;
  os outros vêm dos valores (texto ou número). O `{prefix}` do kernel vale por cima de um
  `prefix` passado pelo plugin.
- **Chave não declarada ou placeholder sem valor lança `TypeError`**: é erro do plugin, e o erro
  do `run` vai para o `plugin.error` como qualquer outro.
- **A config valida a sobrescrita**: só os placeholders do texto padrão, mais `{prefix}`. O texto
  padrão é o contrato entre o plugin e a config: a sobrescrita muda a posição dos valores e pode
  omiti-los, mas não pede um que o plugin não passa. O erro sai como `PluginConfigError`, no
  boot ou no `setOverrides`, e não como `TypeError` na hora de responder.
- **`ctx.plugin.messages` segue cru**, para o código fora de mensagem (`setup`, job), onde não há
  chat para o `{prefix}`. Um `t` ali fica para quando um caso pedir.
- `t` desestruturado funciona (`({ t }) => ...`): a função fica presa à mensagem da visão, criada
  no primeiro acesso, como o `log`.

## Consequências

- O texto de ajuda acompanha o prefixo do chat, e quem sobrescreve controla a frase inteira.
- Uma sobrescrita que já usava `{palavra}` como texto literal passa a ser recusada se `palavra`
  não é placeholder do padrão. É o preço de pegar o erro na config; `{ palavra }`, com espaço,
  segue livre.
- O roteador solto não monta o `t`, como o `signal` e o `expectReply`.
- Plural, gênero e catálogo por idioma seguem fora: o D25 continua valendo para eles.
