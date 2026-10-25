# ADR 0124 — Template e janela de atendimento

**Status:** Aceito (2026-10-25) · Complementa o [ADR 0065](0065-unioes-de-tipo-antes-do-1-0.md) e o
[ADR 0063](0063-retry-after-e-ritmo-do-transport.md)

## Contexto

A API oficial do WhatsApp (Cloud API e BSPs) só aceita conteúdo livre dentro de 24 h da última
mensagem do contato. Fora da janela, só sai template aprovado, e conteúdo livre é recusado (erro
`131047`). Baileys, Telegram, Discord e web não têm a regra. O kernel precisa enviar template, não
re-tentar a recusa e deixar o plugin saber da janela antes de enviar (inbox, disparos).

## Decisão

- **A regra fica no transport**, que vê todo inbound e guarda o último por chat no storage que
  recebe da fábrica ([ADR 0033](0033-transport-por-fabrica.md)). O kernel só tem o contrato.
- **`OutgoingContent` ganha `template`** (`name`, `language`, `params` de cabeçalho, corpo e
  botões), atrás da capability `send.template` (ADR 0065). `assertCanSend` lança `UnsupportedError`
  sem ela. A fila não divide template nem aplica a árvore de formatação (ADR 0057): o tamanho é da
  plataforma. O core não valida se o template existe; inexistente ou pausado volta como erro do
  transport com `retryable: false`.
- **`ConversationWindowError`** (`chatId`, `closedAt`, `retryable = false`), lançado pelo transport
  antes da API quando conhece a janela, ou convertendo a recusa da plataforma. Template nunca o
  recebe. A fila não muda: `retryable: false` já a impede de re-tentar (ADR 0063).
- **`Transport.window?(chatId)`** opcional, sem capability, como o `isChatAdmin`: ausente ou `null`
  é plataforma sem janela, tratada como sempre aberta. `ctx.send.window(chatId)` o chama direto,
  fora da fila (é leitura, como `ctx.groups.metadata`), e resolve `null` sem o método.

## Consequências

- Transports sem janela não mudam; o plugin pode chamar `ctx.send.window` em qualquer um.
- `window` sem capability não deixa um plugin exigir a janela via `requires`; quem precisa trata o
  `null`.
- Um transport com `switch` exaustivo sobre `content.type` ganha o caso `template` (ADR 0065).
- Eventos de mudança de janela (`chat.window`) ficam fora desta decisão.
