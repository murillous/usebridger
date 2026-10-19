# O caminho da mensagem

A [página de entrada](/usebridger/comecando/o-que-e/#o-caminho-de-uma-mensagem) mostra o
diagrama. Aqui está o porquê de cada etapa e o que ela garante ao plugin.

## Fila de entrada: um chat por vez

Toda mensagem entra numa fila **por chat**: as do mesmo chat são processadas em série, na ordem em
que chegaram, e chats diferentes rodam em paralelo. Esse modelo veio do LumaBot e é o que evita as
corridas mais comuns de bot: duas mensagens da mesma pessoa tratadas ao mesmo tempo, uma resposta
saindo antes da anterior, um contador incrementado duas vezes.

A consequência é que **um handler lento segura o chat dele** até terminar ou estourar o prazo
([ADR 0038](../adr/0038-handler-lento-segura-o-chat.md)). Os outros chats seguem normais. Para o
trabalho longo que não precisa de ordem (baixar um vídeo, chamar uma IA), há duas saídas:

- `command({ background: true })`: papel e validação rodam na fila, e o `run` sai dela, com o
  mesmo prazo e o mesmo contexto ([ADR 0083](../adr/0083-comando-em-segundo-plano.md));
- responder rápido e continuar sem `await`, numa promise com `catch` próprio.

Para o trabalho pesado não derrubar o processo, `command({ concurrency })` limita quantos `run`
daquele comando rodam ao mesmo tempo no bot inteiro
([ADR 0084](../adr/0084-limite-de-concorrencia-por-comando.md)).

## Três estágios

Depois da fila, a mensagem passa por três estágios ([ADR 0010](../adr/0010-pipeline-de-3-estagios.md)):

1. **Middlewares**, em camadas (como o Koa), por prioridade: ignorar as próprias mensagens, limite
   de taxa, lista de bloqueio, papéis. Qualquer um pode barrar a mensagem.
2. **Comando**: se o primeiro token casa com um comando registrado, o kernel confere papel e
   `accepts`, roda o `run` e **consome** a mensagem. Nada mais a vê.
3. **Listeners** de `message`, em paralelo, cada um isolado. `claim()` avisa os de prioridade
   menor que alguém já respondeu, para o "não entendi" não sair junto com a resposta de outro
   plugin.

Antes do roteador há uma etapa a mais, a da [conversa de vários passos](#conversa-de-vários-passos).

O comando consome porque comando é intenção explícita: quem digitou `!rank` quer o ranking, não
que três plugins reajam ao texto `!rank`. Os listeners ficam com o resto, a conversa livre, onde
vários plugins podem ter algo a dizer.

## Erro de plugin não derruba o bot

Cada execução de plugin (comando, listener, job, passo de conversa, `setup`) roda isolada, com
`try/catch` e prazo. Uma exceção vira o evento `plugin.error` e uma linha de log com o plugin e a
fase, e o chat segue ([ADR 0004](../adr/0004-plugins-no-mesmo-processo.md)). Não há sandbox: um
plugin pode, de propósito ou por bug grave, travar o event loop ou derrubar o processo. O
isolamento protege de erro, não de código malicioso.

## Prazos e cancelamento

Todo código de plugin tem prazo: 30 s por padrão para comando, listener, job e middleware, e 10 s
para o `setup`. O prazo existe para um bug (uma promise que nunca resolve) não prender um chat para
sempre. Um comando que precisa de mais declara o próprio `timeoutMs`, sem subir o prazo de todos.

JavaScript não interrompe uma função de fora, então o cancelamento é **cooperativo**
([ADR 0029](../adr/0029-cancelamento-cooperativo.md)):

- toda execução recebe um `signal` (`AbortSignal`) que aborta no prazo, com um erro que diz qual
  prazo foi (`CommandTimeoutError`, `ListenerTimeoutError`, `JobTimeoutError`);
- o plugin repassa o `signal` a `fetch` e aos SDKs, que param sozinhos;
- depois do prazo, o contexto **recusa efeitos**: um `reply` atrasado rejeita com
  `ContextExpiredError`, em vez de chegar ao usuário minutos depois e fora de contexto.

O mesmo vale quando o plugin desce (reload, `stop()`): o `signal` do plugin aborta e o que ele
tentar depois é recusado. O tempo esperando na fila de saída **não** conta no prazo: um comando
não estoura porque a fila está segurando o ritmo anti-ban
([ADR 0043](../adr/0043-espera-na-fila-de-saida-fora-do-prazo.md)).

## Conversa de vários passos

Esperar a próxima mensagem dentro do `run` (um `await` até a pessoa responder) seguraria a fila do
chat, e com ela qualquer outra coisa que a pessoa digitasse. Por isso a conversa é feita de
**passos nomeados**: o handler pergunta, registra uma espera com `expectReply('passo')` e
termina. Quando a mesma pessoa responde no mesmo chat, o kernel entrega a mensagem ao passo, que
pode perguntar de novo e encadear ([ADR 0056](../adr/0056-resposta-esperada.md)). O tutorial é a
[conversa guiada](/usebridger/comecando/conversa-guiada/).

As regras respondem às perguntas que toda conversa tem:

- **Quem responde?** A espera é por (chat, remetente). Num grupo, outra pessoa não responde pela
  primeira.
- **E se ela digitar um comando no meio?** O comando ganha: a espera é descartada e o comando roda.
  Assim ninguém fica preso num formulário, e `!ajuda` funciona sempre.
- **E se outra conversa começar?** Há uma espera por pessoa e chat; a nova substitui a anterior.
- **E se ela não responder?** A espera vence (5 minutos por padrão, `ttlMs` para mudar) e some em
  silêncio. Com `onExpire` no passo, o plugin roda um handler nesse momento, na fila do chat, para
  avisar ou limpar ([ADR 0093](../adr/0093-onexpire-do-passo.md)).
- **E se o bot reiniciar?** Por padrão a espera vive em memória e se perde. Com
  `define(passo, handler, { persist: true })`, ela vai ao storage e volta no boot com o tempo que
  faltava; a que venceu durante o restart passa pelo `onExpire`
  ([ADR 0094](../adr/0094-esperas-persistidas.md)).

Botões usam o mesmo mecanismo. Num transport sem botões, o kernel transforma as ações numa lista
numerada e registra uma espera: a pessoa responde `2` e o efeito é o mesmo do clique
([ADR 0058](../adr/0058-acoes-e-botoes.md)).

## Fila de saída

Tudo o que o bot envia (`return` de comando, `reply`, `ctx.send`) passa por uma fila de saída única
por bot ([ADR 0017](../adr/0017-fila-de-saida-anti-ban.md)). Ela existe porque o WhatsApp bane
número que envia rápido demais, e o ritmo só se controla se todo envio passa pelo mesmo lugar:

- **Ritmo:** um intervalo global entre dois envios quaisquer e outro por chat. O padrão do core
  é conservador (300 ms global, 1 s por chat), o do WhatsApp. O transport pode declarar o ritmo
  da plataforma dele, e o app sobrescreve campo a campo
  ([ADR 0063](../adr/0063-retry-after-e-ritmo-do-transport.md)).
- **Prioridade:** resposta a comando sai antes de um broadcast em massa, e o broadcast cheio não
  recusa a resposta.
- **Retry:** falha transitória tenta de novo com espera crescente. Quando a plataforma diz quanto
  esperar (um 429 com `retry_after`), a fila espera exatamente isso. Um envio que estoura o prazo
  (30 s) **não** é repetido, porque ele ainda pode ter saído, e repetir duplicaria a mensagem.
- **Texto longo:** acima do limite da plataforma, a fila divide o texto por parágrafo, linha ou
  espaço, e as partes saem em sequência sem outro envio no meio
  ([ADR 0057](../adr/0057-texto-formatado-neutro.md)).
- **Conexão caída:** a fila pausa e retoma no reconectar
  ([Bot e sessão → quando a sessão cai](bot-e-sessao.md#quando-a-sessão-cai)).

O detalhe de cada opção está em [Fila de saída](../../packages/core/docs/outbound-queue.md).
