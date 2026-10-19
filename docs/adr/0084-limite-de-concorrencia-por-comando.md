# ADR 0084 — Limite de concorrência por comando: `concurrency`

**Status:** Aceito (2026-10-11) · Detalha **D04** ([ADR 0004](0004-plugins-no-mesmo-processo.md))
e **D83** ([ADR 0083](0083-comando-em-segundo-plano.md))

## Contexto

O rate limit de entrada conta mensagens, não custo, e a fila de entrada paraleliza entre chats.
Dez pessoas mandando `!s` com vídeo ou `!download` em chats diferentes sobem dez FFmpeg/yt-dlp ao
mesmo tempo, e um grupo consegue derrubar a CPU e a memória do servidor (#50; plugins `media` e
`download` do LumaBot). Com `background: true` (D83), nem a fila do chat segura mais o mesmo chat.

Pontos a decidir:

- **A espera conta no `timeoutMs`?** Se não contar, a fila de espera não tem fim sob abuso, e um
  comando sem `background` segura o chat além do prazo declarado. Se contar, a fila se esvazia
  sozinha: quem esperou demais recebe o `CommandTimeoutError` de sempre.
- **Quando a vaga volta?** No prazo, o `run` que ignora o `signal` segue rodando (D04/ADR 0029), e
  o teto deixaria de limitar o que ele protege: processos vivos.
- **Resposta "na fila, já já sai" passado um limiar**: dá para fazer depois, sobre o mesmo teto,
  se um plugin precisar; nenhum caso atual exige.

## Decisão

- `command({ concurrency: n })`: no máximo `n` `run` do comando ao mesmo tempo no bot, somando
  todos os chats. Inteiro >= 1, validado na definição como o `timeoutMs`. Sem ele, sem teto.
- A execução excedente espera a vez em ordem de chegada. Papel, `accepts` e `onReject` não entram
  no teto: a espera começa depois deles, no lugar do `run`.
- A espera conta no prazo do `run`. Estourado na fila, o `run` não começa, o comando termina
  `failed` com `CommandTimeoutError` e sai do teto. A rejeição tardia com o próprio erro do prazo
  não é registrada de novo como falha tardia.
- O plugin descendo aborta o `signal` e tira da fila quem espera.
- A vaga volta quando o resultado do `run` assenta, mesmo depois do prazo.
- O teto vive no `wrapCommand` do bot, junto do prazo: um por registro do comando. O roteador
  solto ignora `concurrency`, como o `timeoutMs`.

## Consequências

- Comando pesado tem custo limitado sem o plugin montar fila própria, e quem estoura o prazo na
  espera recebe o mesmo `plugin.error` de um `run` lento.
- Sem `background`, quem espera segura o chat dele (D38), dentro do prazo. Com `background`, a
  espera também sai da fila do chat.
- Um `run` que nunca assenta ocupa a vaga até o plugin recarregar. É o preço de não liberar
  processos vivos; o remédio é respeitar o `signal`.
- No reload, o registro novo começa com o teto inteiro, e os `run` antigos ainda vivos não contam
  nele: por um momento, o total pode passar do teto.
