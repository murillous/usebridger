# ADR 0093 — `react` do contexto tolerante à falta da capability

**Status:** Aceito (2026-10-11) · Substitui em parte **D40**
([ADR 0040](0040-acoes-do-transport-no-plugin.md))

## Contexto

O D40 confere a capability antes de enfileirar toda ação, e o atalho `react(emoji)` do contexto de
mensagem herdou a regra: num transport sem `reactions`, rejeita com `UnsupportedError`. Só que
reação no contexto quase sempre é enfeite de andamento (⏳ ✅ ❌), e o plugin acaba escrevendo um
helper que confere `ctx.capabilities` antes de cada reação (#48; plugin `media` do LumaBot).

## Decisão

- No `BotMessageContext` (middleware, comando, passo e listener de mensagem), `react` sem a
  capability `reactions` resolve sem fazer nada e registra uma linha em `debug` com o `emoji`.
- O `ctx.send.react(key, emoji)` continua estrito, como as outras ações do D40: é o caminho de quem
  precisa saber que a reação não saiu.
- O prazo vem antes: depois dele, o atalho segue recusado com `ContextExpiredError` (ADR 0033).
- A capability é resolvida uma vez por bot, como o `quote` do `reply`.

## Consequências

- Plugin portátil reage sem helper e roda igual em transport sem reações.
- Uma reação que o plugin julgava importante some em silêncio acima do nível `debug`; o remédio é o
  `ctx.send.react` ou declarar `reactions` em `requires`.
- O atalho e o `ctx.send.react` passam a divergir na falta da capability, o que a doc de plugins
  registra.
