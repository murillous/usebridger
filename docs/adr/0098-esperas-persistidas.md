# ADR 0098 — Esperas do `expectReply` persistidas por passo

**Status:** Aceito (2026-10-13) · Substitui em parte **D60**
([ADR 0060](0060-resposta-esperada.md)) · Detalha **D15** ([ADR 0015](0015-storage-kv-e-colecoes.md))
· Segue **D41** ([ADR 0041](0041-reload-em-cascata.md)), **D72**
([ADR 0072](0072-isolamento-por-tenant.md)), **D74** ([ADR 0074](0074-trava-de-sessao-entre-processos.md))
e **D97** ([ADR 0097](0097-onexpire-do-passo.md))

## Contexto

As esperas do `expectReply` vivem em memória (ADR 0060). Um restart (deploy, crash, OOM) perde
toda conversa em andamento, e a resposta cai no roteador como se nada tivesse sido perguntado
(#90). Para conversa curta isso é aceitável. Para cadastro, atendimento, triagem e funil de
pedido, com TTL de horas, um deploy no meio do dia interrompe dezenas de pessoas sem aviso.

O ADR 0060 recusou persistir "antes de existir um caso que precise", pelo custo de I/O em toda
mensagem de quem tem conversa aberta e pela falta de formato no storage. O caso existe agora. O
ADR já tinha deixado o terreno pronto: o passo é nomeado e o `data` é `JsonValue`.

A investigação:

- **O caminho quente não precisa ler o storage.** Um processo por sessão (ADR 0074) é o único que
  escreve as esperas dela, então a memória é a verdade enquanto ele vive. O storage só precisa
  ser a cópia que o boot lê.
- **O `dispose` do plugin roda em três situações que pedem coisas diferentes:** o `stop()` (a
  espera tem de ficar no storage), o reload por troca de config (o usuário não deveria perder a
  conversa porque o operador mudou um valor) e o `disable` (o operador desligou o plugin, a
  conversa acabou). O `dispose` não sabe qual é.
- **O `setup` registra os passos.** Antes do `setup` de todos os plugins, não dá para saber se o
  passo de uma espera ainda existe.
- **O tenant está no `chat.id`** (ADR 0072), então a chave (chat, remetente) já isola tenants. Mas
  o `onExpire` (ADR 0097) roda sem mensagem: recebe o `Chat` e o `Contact` da espera e roda no
  escopo do `chat.tenantId`. A espera restaurada precisa trazer os dois.

Alternativas consideradas:

- **Sempre persistir.** Toda conversa pagaria I/O, inclusive o menu numerado e o fluxo de duas
  mensagens, e todo bot passaria a ler o storage no boot. É o custo que o ADR 0060 recusou.
- **Opt-in por espera** (`expectReply(step, { persist: true })`). O mesmo passo poderia ter esperas
  que sobrevivem e outras que não, e o autor teria de lembrar a opção em todo `expectReply` do
  fluxo. Persistir é propriedade do fluxo, não de uma pergunta.
- **Opt-in no bot** (`createBot({ conversations: { persist: true } })`). O operador ligaria para
  todos os plugins, inclusive os que guardam no `data` algo grande ou volátil. Quem conhece o
  fluxo é o autor do plugin.
- **Ler o storage no caminho da mensagem.** Serviria a várias réplicas da mesma sessão, que a
  trava de sessão já proíbe. Custaria uma leitura por mensagem de quem tem conversa aberta.
- **Guardar o `ttlMs`.** O tempo fora do ar não contaria, e uma espera de 5 minutos poderia valer
  horas depois de um deploy demorado.
- **Restaurar antes do `setup`.** Não daria para descartar a espera de passo que sumiu, e a
  primeira resposta poderia achar o passo ainda não definido.
- **Descartar, no `stop()`, as esperas do storage e regravá-las no boot seguinte.** Não resolve o
  crash, que é metade do problema.
- **Cada plugin persiste no `ctx.storage` e reconstrói no `setup`.** Não há API para registrar
  espera fora de mensagem, e cada plugin repetiria TTL e restauração.

## Decisão

- **Opt-in por passo:** `ctx.conversations.define(step, handler, { persist: true })`. Toda espera
  que aponta para o passo vai ao storage; o `expectReply` não muda. O padrão segue em memória.
- **Leitura em memória, storage como cópia.** O `expectReply` grava (remove a cópia da espera
  anterior, se ela era persistida, e insere a nova); a saída da espera (resposta, comando digitado,
  substituição, vencimento, descarte) remove. A mensagem não lê o storage. As escritas são em
  segundo plano, em série por (chat, remetente), para a remoção nunca passar na frente da
  gravação. Uma falha vai ao log em `warn`, e a espera segue valendo em memória.
- **Onde e como.** Coleção `waits` em `kernelStorage(sessão, 'conversations')` (namespace
  `$conversations` da sessão, [ADR 0036](0036-escopo-de-sessao.md)), um documento por (chat, remetente):
  `{ v: 1, chatId, senderId, chat, sender, plugin, step, data, expiresAt }`.
  - `v` versiona o formato. Mudou o formato, sobe a versão e o boot migra a antiga. Registro de
    versão desconhecida (de um core mais novo, antes de um downgrade) fica intocado.
  - `chatId` e `senderId` são a chave, soltos para a remoção filtrar por eles.
  - `chat` é o `Chat` inteiro (com o `tenantId`); `sender` é o `Contact` **sem os `claims`**:
    atributo verificado do token da sessão (ADR 0057) não vai ao disco nem sobrevive a ela.
  - `expiresAt` é o **vencimento absoluto** em epoch ms, não o `ttlMs`.
  - Registro malformado ou duplicado (uma remoção que falhou) sai no boot; entre duplicados, vale
    o de vencimento mais tardio.
- **Restauração no boot,** depois do `setup` de todos os plugins e antes de a fila de entrada ser
  liberada (a primeira resposta já acha a espera):
  - a espera volta com o tempo que faltava;
  - a que **venceu** durante o restart passa pelo **mesmo ponto de expiração** do timer de TTL,
    como se ele tivesse disparado com o bot fora;
  - a de passo que não existe mais (plugin desligado ou que não subiu, passo renomeado) é
    **descartada com `warn`** e sai do storage. A vencida e órfã também vai para esse descarte,
    não para a expiração.
  - Falha ao ler o storage vai ao log em `error`, e o boot segue sem as conversas: perdê-las é
    melhor que não subir.
  - Sem nenhum passo persistido definido, o boot não lê a coleção. Um registro que sobrar espera o
    boot que voltar a ter o passo.
- **Reload mantém, desligar remove.** O `dispose` tira da memória só as esperas não persistidas.
  Depois de cada mudança de plugin (`reload`, `disable`, `enable`) e no boot, o bot descarta com
  `warn`, também do storage, as esperas cujo passo não está definido. Assim o reload que redefine
  o passo as mantém, e o `disable`, o `setup` novo que falha e o passo que sumiu as removem. No
  meio do reload, antes de o passo voltar, a espera fica intocada: a resposta que chega segue o
  fluxo normal sem consumi-la, e a que vence nessa janela tem a expiração retomada depois do
  `setup` novo, com o `onExpire` dele. Quem decide se ela fica é a varredura do fim do reload.
- **`stop()`** tira tudo da memória sem tocar no storage e espera as escritas pendentes antes de
  liberar a trava da sessão e fechar o storage.
- **Uma sessão por processo basta.** A trava de sessão (ADR 0074) garante um só processo lendo e
  escrevendo as esperas de uma sessão. Não há leitura no caminho quente nem compare-and-set.
- **Kit de testes:** `TestBot.restart(overrides?)` para o bot e sobe outro sobre o mesmo storage,
  que o kit agora cria e só fecha no `stop()` do último bot.

### Interação com o `onExpire` ([ADR 0097](0097-onexpire-do-passo.md), #89)

O ADR 0097 concentra a expiração num ponto único: o timer da espera com `onExpire` chama o
`onDue` do registro, o bot põe a tarefa na fila do chat (`expireWait`) e, na vez dela,
`flow.expireReply` chama `ConversationRegistry.expire`, que só retira a espera se ela venceu
(`due` ou `Date.now() >= dueAt`). Espera sem `onExpire` some direto, em silêncio.

A restauração usa o mesmo caminho, sem atalho:

- a espera restaurada **ainda válida** arma o timer pelo mesmo `#arm` da espera nova, com o tempo
  que faltava; ao vencer, segue o caminho acima;
- a restaurada **já vencida** passa pelo mesmo passo que o timer dispara (`#due`): com
  `onExpire`, vai ao `expireWait`, entra na fila do chat e roda assim que o boot libera a fila
  (`flow.expireReply` espera o `ready`), no escopo do `chat.tenantId` guardado; sem `onExpire`,
  some. O envio do `onExpire` espera na fila de saída, pausada até a conexão abrir
  ([ADR 0048](0048-connect-resolve-ao-iniciar.md));
- a **órfã** não chega a esse ponto, porque não há passo para chamar: vai ao descarte com `warn`;
- `ConversationRegistry.expire` enfileira a remoção da cópia no storage ao retirar a espera, antes
  de o `onExpire` rodar. Um crash entre os dois pode repetir o `onExpire` no boot seguinte; perder
  a remoção é o mesmo risco de qualquer escrita que falha (abaixo).

## Consequências

- Mudança aditiva: `StepOptions` (o terceiro argumento de `define`) ganha `persist`. Plugin que não o usa
  não muda, nem no custo: sem passo persistido, nada vai ao storage e o boot não lê a coleção.
- Custo de quem usa: uma escrita por `expectReply` e uma remoção por espera que sai, fora do
  caminho da mensagem. Com uma espera persistida aberta, a mensagem que responde paga só o
  enfileiramento da remoção.
- A espera persistida sobrevive a crash, deploy e reload. O usuário só perde a conversa se o
  plugin for desligado, não subir ou renomear o passo, e o operador vê o `warn`.
- Uma escrita que falhou deixa a cópia desatualizada: a espera pode não voltar, ou voltar já
  respondida, depois de um restart. O `warn` registra cada falha.
- O `data` de uma espera persistida fica no storage até ela sair. Quem guarda dado sensível no
  `data` precisa saber disso; a doc avisa.
- No `onExpire` de uma espera restaurada, `sender.claims` fica ausente.
- O `@usebridger/testing` passa a criar o storage em memória (antes era o padrão do `createBot`) e
  o fecha no `stop()` do `TestBot`. O comportamento visto pelo teste não muda.
