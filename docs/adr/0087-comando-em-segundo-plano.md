# ADR 0087 — Comando em segundo plano: `background: true`

**Status:** Aceito (2026-10-11) · Detalha **D42** ([ADR 0042](0042-handler-lento-segura-o-chat.md))
e **D49** ([ADR 0049](0049-evento-de-comando.md))

## Contexto

Pelo D42, o comando segura a fila do chat até o `run` terminar ou estourar o prazo. O `!download`
do LumaBot tem `timeoutMs: 240_000`: num grupo, um vídeo grande segura as outras mensagens daquele
chat por até 4 min, inclusive as da Luma. A conversão de vídeo do `!sticker` e as chamadas de IA
têm o mesmo perfil (#49).

A receita do D42 é responder rápido e soltar o trabalho numa promise sem `await`. Para comando,
ela custa caro: o trabalho solto sai do prazo (`timeoutMs` deixa de valer), do `plugin.error`, do
evento `command` (que diz `ran` antes de o trabalho acabar) e do `bot.settled()`, e o plugin
remonta à mão o timeout e o destino do erro.

Alternativas consideradas:

- **`ctx.detach()` no meio do `run`**: o trecho antes do detach mantém a ordem, mas a execução
  passa a ter dois prazos (antes e depois) e troca de estado no meio. O trecho que precisa de
  ordem num comando longo (validar o argumento, responder "baixando…") não depende de ordem com
  as mensagens seguintes.
- **Manter a receita do D42**: custa o prazo, o destino do erro e o `settled()` de todo plugin
  com comando longo.

## Decisão

- `command({ background: true })`: papel, `accepts` e `onReject` rodam na fila do chat, como
  antes. O `run` começa ali e a fila não o espera: a próxima mensagem do chat segue na hora.
- O `run` mantém o contexto inteiro: `reply` citando a mensagem original, `react`, `log` com o
  chat, `expectReply` e o `signal`. O prazo é o mesmo de sempre (`timeoutMs` do comando ou
  `timeouts.commandMs`); estourado, aborta o `signal` e recusa o `reply`.
- A falha (inclusive o prazo) vai para `plugin.error` com `phase: 'command'`, e o evento `command`
  sai quando o `run` termina, com `ran` ou `failed`.
- O roteador devolve `status: 'background'` com `done`, a promise do resultado final (`ran` ou
  `failed`), que nunca rejeita. O `Bot` reporta quando ela assenta.
- `bot.settled()` espera os `run` em segundo plano.
- Shutdown e reload não drenam: o `run` vive até o plugin descer, quando o `signal` aborta e o
  contexto recusa o que ele tentar (ADR 0033), como qualquer execução do plugin. Um `run` que
  ignora o `signal` é abandonado no fim do `stop()`, e o `settled()` deixa de esperar por ele.

## Consequências

- Comando longo libera o chat sem perder prazo, destino do erro, `command` nem `settled()`.
- Duas execuções do mesmo chat podem terminar fora de ordem, e o `run` em segundo plano não tem
  ordem com as mensagens que chegam depois. Quem precisa de ordem não usa `background`.
- Não há teto de execuções em segundo plano por chat: o limite de concorrência por comando é a
  #50.
