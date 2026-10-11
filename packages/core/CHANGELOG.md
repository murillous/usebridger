# @usebridger/core

## 0.2.1

### Patch Changes

- 4e846ec: README na raiz do pacote, para a página do npm mostrar descrição, instalação, um exemplo e os links da documentação.

## 0.2.0

### Minor Changes

- e190d3e: Release de teste do fluxo `develop` → `main` com Trusted Publishing (ADR 0085), sem mudança de API em relação à 0.1.0.

## 0.1.0

### Minor Changes

- b7eb3a7: Adiciona `createBot(config)` com `start()`/`stop()`, máquina de estados (`bot.state`) e ganchos
  de parada (`onStop`) para shutdown gracioso, sem estado global nem side effect em import.
- 70220de: O plugin passa a fazer pela API pública tudo o que o transport sabe, sem `ctx.unsafe.native`
  (#224, ADR 0040). `ctx.send` ganha `react`, `edit`, `delete` e `presence`. Essas ações passam pela
  fila de saída com as mesmas regras do envio e aceitam `{ priority }`. `ctx.groups` traz
  `metadata(groupId)`, que lê direto no transport, e `updateParticipants(groupId, ids, action)`, que
  passa pela fila. Sem a capability, a ação rejeita na hora com `UnsupportedError`; depois do
  descarte do contexto, com `ContextExpiredError`.
  
  Leituras novas no contexto: `ctx.commands.list()` traz os comandos de todos os plugins, sem o
  `run`. `ctx.self` é o contato da sessão. `ctx.capabilities` informa o que o transport suporta, para
  recurso opcional.
  
  Toda `Message` traz `key` (`MessageKey`), derivada por `createMessage`, inclusive na citada. O
  contexto de comando e o de listener de mensagem ganham o atalho `react(emoji)`, com prioridade
  `'high'` e o mesmo prazo do `reply`. O transport pode emitir o evento novo `contact.updated`
  (`{ id, name?, phone? }`), que passa sempre pelo `chatFilter`.
  
  Novos tipos exportados: `Outbound`, `ActionOptions`, `Groups`, `CommandInfo`, `GroupMetadata`,
  `GroupParticipant` e `Presence`. Quem monta `Message` à mão precisa preencher `key`.
- 5eb7203: Ações e botões: o clique dispara um comando, com fallback em texto numerado (ADR 0062).
  
  - `ctx.reply(text, { actions })` e `ctx.reply.text` aceitam `actions`: `{ label, command, args? }`
    roda um comando registrado, e `{ label, step, data? }` roda um passo de conversa do plugin. O
    clique passa pela fila do chat e pelos middlewares e segue o caminho do comando digitado, com
    papel, recusa, evento `command` e `plugin.error`.
  - O botão leva só um ID opaco, preso ao chat e válido por 24 horas. Clique vencido, desconhecido
    ou de outro chat é descartado com log em `debug`.
  - Capability `actions`, `SendOptions.actions` (`{ id, label }`), `TextLimits.actions` e o evento
    `interaction` no `TransportEvents`, que o kernel consome e não repassa aos plugins.
  - Sem a capability, ou acima de `limits.actions`, o texto ganha o menu numerado, e o número que o
    remetente responder roda a ação.
  - `CommandRouter.dispatch` ganha o segundo parâmetro opcional `invocation`.
  - Novos exports: os tipos `CommandAction`, `MessageAction`, `StepAction`, `ReplyTextOptions` e
    `OutgoingAction`, e `Interaction` em `@usebridger/core/adapter`.
- 1d16c73: Forma curta do plugin (ADR 0079). O manifesto aceita `commands` (nome → comando) e `on`
  (evento → listener), com o contexto do plugin no 2º argumento; o kernel os registra com
  `ctx.commands.add`/`ctx.events.on` antes do `setup`, que passa a ser opcional. Declarar `commands`
  já exige `send.text`. O manifesto valida comando sem `run`, nome inválido e evento desconhecido,
  para quem escreve em JavaScript. Novos tipos: `PluginCommand`, `PluginListener` e
  `PluginListeners`.
  
  **Mudança de comportamento:** no bot, o `run` de qualquer comando que devolve texto (string ou
  `fmt`) responde com ele, citando a mensagem. Quem devolvia uma string sem querer passa a
  responder; outros valores, como a chave de um `c.reply(...)` devolvido, seguem ignorados.
- 852e5f3: Boot sequencial e cancelamento cooperativo (M1-16). O `start()` volta à ordem do plano: carrega
  os plugins e só então chama `transport.connect()` — plugin quebrado (ex.: conflito de comando)
  faz o `start()` rejeitar sem conectar. Comandos (`c.signal`), listeners (`e.signal`), handlers de
  job (`(payload, { signal })`) e o `PluginContext` (`ctx.signal`) ganham um `AbortSignal` que
  aborta no prazo (ou no descarte do contexto), reaproveitando os timers que já existiam. Depois
  do prazo, o `reply` daquele contexto rejeita com o novo `ContextExpiredError`; depois do descarte
  do plugin, `send`, `storage` e `scheduler.at`/`cancel` também. `PluginContextHandle.dispose`
  aceita o motivo do descarte, e `EventBus.forPlugin` aceita uma visão por listener (uso do kernel).
- 75de529: Pipeline integrado no `Bot` (M1-16): `createBot()` passa a aceitar `storage`, `plugins`,
  `pluginDirs`, `disabledPlugins`, `pluginConfig`, `owners`, `prefix`, `logger`/`logLevel`/
  `secrets`, `middlewares`, `inbound`, `outbound`, `reconnection` e `timeouts`, e liga as peças do
  M1: a mensagem do transport passa pela fila de entrada, pelos middlewares (`ignoreSelf` e
  `sanitize` ligados por padrão), pelo roteador e, se não for comando, pelos listeners, com
  `reply` e `log` no contexto; os plugins sobem com o contexto real (config, comandos, eventos,
  serviços, storage, scheduler, `send`, `unsafe`), e conflito de comando derruba o boot. O `run`
  de cada comando tem prazo (`timeouts.commandMs`, padrão 30 s): estourado, sai `plugin.error`
  com `timedOut: true` (`CommandTimeoutError`) e o chat é liberado. O
  `stop()` drena a fila de entrada, faz o `teardown` dos plugins, para o scheduler, drena a fila
  de saída, desconecta e fecha o storage. A `ReconnectionPolicy` é executada pelo bot
  (`reconnection.clearSession`), e `bot.config` expõe `setOverrides`/`describe`/`jsonSchema`.
  
  Texto de trabalho `ctx.text` (`MessageContext.text`, `BotMessageContext`): o `sanitize` grava
  nele o texto truncado (além de `ctx.sanitized`), e o roteador e os listeners o leem.
  
  **Quebra:** `Contact.phone` (`string | null`, só dígitos) passa a ser obrigatório — transports
  informam `null` quando não sabem o telefone — e `role: 'owner'` compara `owners` com
  `sender.phone` em vez de `sender.id`. `ListenerContext` vira tipo condicional com
  `message`/`text`/`reply`/`log` nos eventos de mensagem, e os extras de `bus.emit` passam a ser
  opcionais em todo evento.
- e8353c5: `bot.settled()` espera o bot terminar de processar o que recebeu (#237): resolve quando a fila de
  entrada, os listeners em andamento (inclusive de eventos diretos e `plugin.error`) e a fila de
  saída estão ociosos ao mesmo tempo, repetindo a espera enquanto um realimenta o outro. Durante o
  boot, espera os plugins subirem; com a fila de saída pausada, espera a reconexão ou o
  `maxPauseMs`. Jobs do scheduler ficam de fora. Nunca rejeita. É a base do `receive()` do
  `@usebridger/testing` e permite afirmar em teste que nada foi enviado (ADR 0044).
- 80a15c2: `bot.stats()` expõe as métricas das filas de entrada e de saída (#204). Ele devolve `{ inbound,
  outbound }` com os contadores que as filas já mantinham: mensagens processadas, descartadas e com
  erro; envios feitos, falhos, re-tentados e descartados; o backlog e se a fila de saída está pausada
  pela conexão caída. A leitura é O(1) e cada chamada devolve uma cópia. Antes do `start()`, tudo é
  zero; depois do `stop()`, ficam os valores finais. Novos tipos exportados: `BotStats`,
  `InboundQueueStats` e `OutboundQueueStats`.
- 7b8ab13: Capabilities multiplataforma (ADR 0070). **Quebra de API antes do 1.0.**
  
  - A capability `presence` dá lugar a `typing`. O `Transport` troca `sendPresence(chatId, presence)`
    por `sendTyping(chatId, kind)`, com `TypingKind = 'text' | 'voice'`, e o tipo `Presence` sai. No
    plugin, `ctx.send.presence(chat, 'composing')` vira `ctx.send.typing(chat, 'text')`, e o
    `requires: ['presence']` vira `['typing']`. O status online global (`available`/`unavailable`) e o
    `paused` saem do contrato: use `ctx.unsafe.native`. A opção `outbound.onPresenceError` passa a se
    chamar `onTypingError`.
  - Enquete: `multiple?: boolean` no lugar de `selectableCount?: number`, no `OutgoingContent` e no
    `ctx.reply.poll`.
  - O contrato de `react` e `delete` fica explícito: a sessão tem uma reação por mensagem (`react`
    substitui, `null` remove a da sessão); apagar mensagem de outra pessoa exige admin ou a permissão
    da plataforma.
- a57530d: O `Chat` ganha os campos opcionais `kind` (`'dm' | 'group' | 'channel' | 'thread'`, tipo
  exportado `ChatKind`), `parentId` (o espaço a que o chat pertence: o servidor do Discord ou o
  supergrupo do Telegram) e `title`. Um `Chat` só com `id` e `isGroup` continua válido.
  
  O `chatFilter` passa a casar `allow` e `block` também contra o `chat.parentId`: liberar ou
  bloquear um servidor vale para todos os canais dele, e um canal bloqueado continua de fora com o
  servidor liberado. No WhatsApp não há `parentId`, então nada muda lá.
- d0654e8: Novo evento `connection.pairing-code` (`{ code }`, ADR 0050): o transport que pareia por código o
  emite no lugar do `connection.qr`. O bot o trata como o QR: conta para o `maxQrCount` da
  reconexão, loga o valor só em `debug` e o repassa ao barramento.
- ec3cdc7: Comandos nativos: o transport lê a lista de comandos e recebe os comandos chamados pelo menu da
  plataforma (ADR 0064).
  
  - `TransportDeps.commands` (opcional): `list()` devolve os comandos como `CommandInfo`, e
    `onChange(listener)` avisa que a lista mudou, uma vez ao fim de cada reload e uma vez por tick
    para os comandos adicionados fora dele. Não avisa no boot nem a partir do `stop()`.
  - O `Interaction` vira a união de `ActionInteraction` (`actionId`, o clique num botão) e
    `CommandInteraction` (`command` e `args` em texto livre). O kernel roda o comando nativo como o
    digitado, sem prefixo, com papel, recusa e evento `command`.
  - Quem lê `Interaction.actionId` precisa estreitar o tipo antes (`interaction.command ===
    undefined`).
  - Novos exports em `@usebridger/core/adapter`: os tipos `TransportCommands`, `ActionInteraction` e
    `CommandInteraction`.
- 2bc4478: Roteador de comandos (M1-6): `command()` para declarar comandos, prefixo configurável, aliases,
  match por token inicial exato (sem diferenciar caixa), parse de args com aspas, `accepts`
  (incluindo `quoted:*`) com `ctx.media` resolvido e `onReject`, papéis `owner` / `group-admin` /
  `everyone` e `CommandConflictError` quando dois comandos disputam o mesmo nome ou alias.
- 9b513b5: Segredos não entram mais por override de config (M1-13): `setOverrides` recusa qualquer campo
  `secret`, inclusive aninhado, com `PluginConfigError` (fonte `override`) que aponta a variável
  `BRIDGER_<PLUGIN>__<CAMPO>` e o caminho no arquivo; nada é salvo e o plugin segue com a config
  atual. Override legado com segredo no storage tem o campo ignorado em `resolve`, com aviso no log
  sem o valor. O JSON Schema de `jsonSchema` marca os campos secretos com
  `x-bridger-override: false`.
- aed50f6: Config por plugin (M1-13): `createPluginConfigs()` valida a config de cada plugin com o schema
  Zod do manifesto, com precedência env (`BRIDGER_<PLUGIN>__<CAMPO>`, com coerção de tipo) >
  arquivo (`pluginConfig`) > overrides no storage > default; `PluginConfigError` lista campo e
  fonte de cada problema. Campos `secret()` são mascarados em `describe()`, marcados no JSON
  Schema exportado (`jsonSchema()`) e nunca logados: o logger aceita um `SecretSet`
  (`createSecretSet()`) consultado a cada linha, para segredos resolvidos ou alterados depois da
  criação. `setOverrides()` valida antes de salvar e dispara o reload do plugin (`teardown` →
  `setup`). `messages` sobrescrevível pela config, com erro para chave desconhecida.
  `normalizeOwners()`/`normalizePhone()` normalizam os telefones de `owners`.
- 446b644: Conflito de papel (`RoleConflictError`) ou de serviço (`ServiceConflictError`) no `setup` passa a derrubar o boot, como o conflito de comando, conforme o ADR 0035. Antes, o plugin que chegava depois era só ignorado, e quem respondia pelo papel ou serviço dependia da ordem de carga. Num `reload`, o conflito continua só ignorando o plugin recarregado.
- ae2e207: Queda durante o `connect()` não deixa mais o bot `running` sem conexão (#253, ADR 0048). O
  contrato de `Transport.connect()` agora diz que ele resolve ao iniciar a tentativa, sem esperar o
  `open`. Um `closed` que chega antes de o `connect()` terminar (o inicial ou o de uma reconexão) é
  guardado e decidido quando ele termina, a menos que um `open` venha depois. A fila de saída
  fica pausada desde o `start()` até o primeiro `open`, então os envios do `setup` e dos jobs
  vencidos esperam a conexão (até `outbound.maxPauseMs`, contado desde o `start()`). **Atenção,
  adapters:** o transport precisa emitir `connection.status` `open`, ou nada é enviado.
- 4b1919a: O `Contact` ganha os campos opcionais `username` (o `@usuario` do Telegram e do Discord), `isBot`
  e `claims`. Os `claims` são atributos que o transport verificou, como os do JWT do web, e o
  plugin só os lê. Um `Contact` só com `id`, `name` e `phone` continua válido.
  
  Novo middleware oficial `ignoreBots`, **ligado por padrão** (`middlewares: { ignoreBots: false }`
  desliga). Ele barra as mensagens, as edições, as reações e as deleções feitas por contatos com
  `isBot: true`, para dois bots não entrarem em loop. No WhatsApp o `isBot` não vem preenchido,
  então nada muda lá.
- 88a9c22: Contratos compartilhados do M1-7 ao M1-15 (só tipos): `PluginManifest`, `PluginDefinition` e
  `PluginContext`, `BotEvents` e `EventSubscriber`, `Logger`, `Services`/`ServiceAccess`,
  `StoragePort`/`PluginStorage`, `Scheduler`, `Sender` e `Unsafe`. Dependências `zod` e `pino`.
- fe9f458: `defineTransport` em `@usebridger/core/adapter` (ADR 0080): o adapter descreve só `name`,
  `capabilities` (em lista), `connect`, `disconnect`, `send` e os métodos das capabilities que
  declara, e recebe um kit com `emit` e `setSelf`. O `Transport` montado traz o emissor, o `on()`,
  o `self`, a checagem de capability em cada método e o `UnsupportedError` no que falta. Novos
  tipos: `TransportSpec` e `TransportKit`.
  
  **Mudança de comportamento:** o `createBot` passa a recusar, com `BotConfigError`, o transport
  com capability desconhecida, capability sem o método dela (`reactions` sem `react`) ou sem
  `connect`, `disconnect`, `on` ou `send`. Antes, o erro só aparecia quando um plugin usava o
  recurso.
- fdee994: Desconexão fatal e transport sem pareamento (ADR 0068). Corrige o laço de `clean-session` de um
  token inválido (#280).
  
  - `DisconnectReason` ganha `'fatal'`: erro de configuração que reconectar não resolve (token sem
    permissão, intents, porta ocupada). A `ReconnectionPolicy` decide `stop` com causa `fatal`.
  - Capability `pairing`: a sessão se pareia por QR ou código. Sem ela, `auth-failed` decide `stop`
    com causa `auth-failed`, em vez de limpar a sessão e falhar de novo a cada
    `minCleanIntervalMs`. `ReconnectionPolicyOptions.pairing` (padrão `true`); o `Bot` a preenche
    com a capability do transport, e `BotReconnectionOptions` não a aceita.
  - O bot loga esses dois `stop` em `fatal`, com `reason`, `cause` e o erro nativo em `err`, e para.
    O `closed` chega aos listeners de `connection.status` antes, para o app decidir o código de
    saída.
  - `docs/transport.md`: o adapter sobre uma lib que se reconecta sozinha só emite `closed` quando
    a queda é terminal, e uma tabela de mapeamento de Discord, Telegram e web.
  - Um transport que pareia por QR e emite `auth-failed` precisa declarar `pairing` para continuar
    limpando a sessão. Um `switch` exaustivo sobre o `DisconnectReason` ou sobre a causa do `stop`
    precisa tratar `fatal` (e `auth-failed`, na causa).
- 4ec2ad2: API pública por público (M1-17, ADR 0034). **Breaking:** o `@usebridger/core` deixa de exportar
  peças do kernel e o que é de transport/storage passa para o novo subpath
  `@usebridger/core/adapter`.
  
  - `@usebridger/core`: API do autor de plugin e da composição do app (inalterada para quem só
    usa `definePlugin`, `command`, `secret`, `createBot`, middlewares oficiais, `createLogger`,
    `createSecretSet`, `createMemoryStorage`, tipos de contexto, mensagem, eventos e storage do
    plugin). Os tipos de transport que aparecem na API do plugin ficam nele: `MediaInput`,
    `MessageKey`, `OutgoingContent`, `SendOptions`, `ConnectionStatus`, `DisconnectReason`,
    `GroupParticipantAction`, `Unsubscribe`, além do `Capability` e do `UnsupportedError`.
  - Novo `@usebridger/core/adapter`, para quem escreve transport ou storage. Saem do
    `@usebridger/core` e passam a vir dele: `createMessage`/`MessageInit`, `createMedia`/
    `MediaSource`, `TypedEmitter`/`EmitterErrorHandler`, `messageKey`, `ReconnectionPolicy` e
    seus tipos (`ReconnectionDecision`, `ReconnectionPolicyOptions`, `ReconnectionState`),
    `CAPABILITIES`, `CapabilityHolder`, `hasCapability`, `assertCapability`,
    `missingCapabilities`, `capabilitiesForSend`, `assertCanSend`, `isCapability`,
    `TransportEvents`, `TransportEventName`, `TransportEventHandler`, `GroupMetadata`,
    `GroupParticipant`, `Presence`, `AuthKeyData`, `AuthStateStore`, `StorageClosedError`,
    `normalizeQuery`, `normalizeWhere`, `normalizeDocument`, `normalizeIndexes`,
    `assertFieldName`, `cloneJson`, `FilterOperator`, `NormalizedCondition`, `NormalizedQuery`,
    `NormalizedSort`. `Transport` e `StoragePort` saem nas duas entradas.
  - Deixam de ser exportados (internos do kernel, sem substituto público): `createPluginHost` e
    seus tipos e constantes (`PluginHost`, `PluginHostOptions`, `PluginHostState`,
    `PluginHostStateError`, `PluginContextFactory`, `PluginContextHandle`,
    `DEFAULT_SETUP_TIMEOUT_MS`, `DEFAULT_TEARDOWN_TIMEOUT_MS`), `createEventBus` (`EventBus`,
    `EventBusOptions`, `EmitExtras`, `EmitResult`, `EmittableEventName`,
    `DEFAULT_LISTENER_TIMEOUT_MS`), `createSchedulerService` (`SchedulerService`,
    `SchedulerServiceOptions`, `DEFAULT_JOB_TIMEOUT_MS`, `DEFAULT_STORAGE_RETRY_MS`),
    `createPluginConfigs` (`PluginConfigs`, `PluginConfigsOptions`, `ResolvedPluginConfig`),
    `createCommandRouter` (`CommandRouter`, `CommandRouterOptions`, `CommandMatch`,
    `DispatchResult`, `IsGroupAdmin`, `MatchedCommand`), `createCommandRegistry`
    (`CommandRegistry`, `RegisteredCommand`), `parseArgs`, `createServiceRegistry`
    (`ServiceRegistry`, `ProvidedService`), `createUnsafeAccess` (`UnsafeAccess`,
    `UnsafeAccessOptions`), `MiddlewarePipeline`, `MiddlewareOptions`, `RateLimiter`,
    `RateLimiterOptions`, `InboundQueue` e tipos (`InboundQueueOptions`, `InboundQueueStats`,
    `InboundTask`, `EnqueueResult`), `OutboundQueue` e tipos (`OutboundQueueOptions`,
    `OutboundQueueStats`, `OutboundTransport`, `OutboundCloseOptions`, `HumanizeOptions`,
    `RetryOptions`), `createReply`/`CreateReplyOptions`, `sortPlugins`/`OrderableManifest`,
    `satisfies`, `isValidRange`, `formatBootTable`, `describeSkipReason`, `collectPlugins`,
    `discoverPlugins`, `CollectPluginsOptions`, `PluginEntry`, `assertPluginDefinition`,
    `manifestIssues`, `PLUGIN_NAME_PATTERN`, `normalizeOwners`, `normalizePhone`, `envName`,
    `isSecretSchema`, `SECRET_MASK`, `createNoopLogger`, `MIN_SECRET_LENGTH`, `kernelStorage`,
    `pluginStorage`, `isReservedNamespace`, `ReservedNamespaceError`. O que o app configura
    dessas peças continua na config do `createBot` (`inbound`, `outbound`, `pluginDirs`,
    `owners`...).
- 98cbf9c: Vários bots num storage (ADR 0075): `ctx.storage.shared` guarda dados do plugin comuns a todas as
  sessões que dividem o storage (um bot por transport: WhatsApp, Telegram, web), no namespace
  `$shared:<plugin>`, e segue o tenant como o `ctx.storage`. `ctx.transportName` traz o nome do
  transport do bot, para compor a chave do escopo comum quando ela vem de um ID. Mudança aditiva:
  `ctx.storage` passa a ser `PluginContextStorage` (`TenantStorage` com `shared`).
- b2acde9: A espera do `reply` na fila de saída não conta mais no prazo do handler (#240, ADR 0047). Antes,
  uma rajada de comandos em chats diferentes estourava `timeouts.commandMs` esperando a taxa global
  da fila (300 ms entre envios), e saía `plugin.error` com `timedOut: true` para comandos que
  funcionaram. Agora o prazo de comando (`run` e `onReject`) e de listener pausa enquanto um
  `reply` ou `react` do contexto não assenta, cobrindo fila, humanização, re-tentativas e transport,
  e volta com o tempo que sobrou. O `ctx.send` do plugin, `ctx.groups` e os jobs seguem contando.
- 53baf51: Barramento de eventos (M1-7): `createEventBus()` com todos os eventos do §6.4 tipados, incluindo
  `message:<type>` derivado de `message`; filtros declarativos (`on('message', { quoted: 'audio' },
  h)`, opções no meio ou no fim); listeners iniciados em paralelo por prioridade, com `claim()`
  compartilhado na emissão; isolamento por try/catch + timeout por listener, com falhas emitidas
  como `plugin.error` (nome do plugin, evento, `timedOut`) e entregues ao `onError` do bus;
  `forPlugin`/`removePlugin` para atribuir e remover os listeners de cada plugin.
- 95a58e7: Novo evento `command` (#254, ADR 0049): sai depois de todo comando que casou, com
  `{ plugin, name, invokedAs, status, message }` e `status` `ran`, `rejected` ou `failed`. É só de
  observação (sem `reply`) e, junto com `message`, deixa o plugin ver toda mensagem, comandos
  inclusive. Exporta o tipo `CommandEvent`.
- 285dff9: A fila de saída espera a reconexão em vez de perder as respostas (#198, ADR 0039). Antes, numa
  queda de conexão, cada envio esgotava o retry em ~3 s, antes da primeira reconexão (5 s). Agora o
  bot pausa a fila no `connection.status` `closed` e retoma no `open`. O que aguarda espera até
  `outbound.maxPauseMs` (padrão 60 s); estourado esse teto, rejeita com `OutboundQueueError`
  `'disconnected'`, e os envios novos rejeitam na hora até a conexão voltar. O `stop()` com a
  conexão caída descarta o que aguarda em vez de gastar o prazo drenando.
  
  Toda chamada da fila ao transport ganha prazo, `outbound.sendTimeoutMs` (padrão 30 s; #202). Um
  `transport.send` sem resposta rejeita com `OutboundQueueError` `'timeout'`, sem re-tentar, e libera
  o chat. Presença sem resposta vai para `onPresenceError`, e o envio segue.
  
  `OutboundQueueError['reason']` ganha `'disconnected'` e `'timeout'`.
- 2fca36a: `chatFilter` e `ignoreSelf` valem para os eventos que não são mensagem (#219, ADR 0038). Antes,
  `reaction`, `message.deleted` e `group.*` iam direto aos listeners: chegavam de chat bloqueado, a
  reação da própria sessão voltava para os plugins e o evento que chegava durante o boot se perdia.
  Agora o bot aplica a mesma config de middlewares a esses eventos: o `chatFilter` barra `reaction`
  e `message.deleted` por `chat.id` e `group.participants` e `group.updated` por `groupId`
  (`group.joined` e `group.left` sempre passam), e o `ignoreSelf` barra a reação e a deleção com
  `fromMe: true`. Esses eventos esperam o fim do boot, sem entrar na fila do chat.
  
  **Breaking (adapters):** os payloads de `reaction` e `message.deleted` em `TransportEvents` ganham
  o campo obrigatório `fromMe: boolean`, que o adapter preenche.
- 39e7242: Grupos multiplataforma (ADR 0059). **Quebra de API antes do 1.0.**
  
  - O `Transport` ganha o método opcional `isChatAdmin(chat, contact)`. Com ele, o papel
    `group-admin` pergunta ao transport, com o `Chat` inteiro (inclusive o `parentId` do servidor),
    e não precisa da lista de participantes. Sem ele, o kernel segue procurando o remetente nos
    `participants` do `getGroupMetadata`, como antes.
  - `GroupMetadata.participants` fica opcional: ausente onde a plataforma não lista membros. Sem a
    lista e sem `isChatAdmin`, o `group-admin` recusa. `GroupMetadata.subject` passa a se chamar
    `title`.
  - A capability `groups.admin` dá lugar a `groups.add`, `groups.remove` e `groups.promote` (que vale
    também para `demote`). `ctx.groups.updateParticipants` cobra a capability da ação pedida. Troque
    `groups.admin` no `requires` dos plugins pela da ação que eles usam. O helper
    `groupActionCapability(action)` sai em `@usebridger/core/adapter`.
  - Os eventos `group.joined`, `group.left`, `group.participants` e `group.updated` trocam `groupId`
    por `chat: Chat`, e `group.updated.subject` passa a se chamar `title`. O `chatFilter` casa
    `group.participants` e `group.updated` também pelo `chat.parentId`.
- 54ecf98: HTTP do core (ADR 0076): `createHttp({ port })` passado em `BotConfig.http`, o mesmo servidor
  para todos os bots do processo. A porta só abre se houver rota e fecha quando o último bot para.
  Plugins registram rotas e WebSocket em `ctx.http` (sob `/plugins/<nome>`) e transports em
  `TransportDeps.http` (sob `/transports/<name>`), com `Request`/`Response` da Web API; outra
  sessão que não a `default` fica sob `/sessions/<sessão>`. `/health` responde 200 com todas as
  sessões em `running` e 503 senão. Erro de rota de plugin sai em `plugin.error` com
  `phase: 'http'`.
- 38de373: Adiciona `InboundQueue`, a fila de entrada por chat: serializa o mesmo chat e paraleliza chats
  distintos, com limite de backlog por chat, métricas (`stats()`) e shutdown gracioso
  (`close()`/`onIdle()`).
- 166a1fe: Isolamento automático por tenant (ADR 0072): o transport marca o cliente verificado em
  `chat.tenantId`, e o mesmo `ctx.storage` do plugin passa a gravar no namespace daquele tenant em
  toda mensagem ou evento do chat. Isso inclui a closure do `setup`, o service de outro plugin
  chamado pelo handler e o job agendado nele, que guarda o tenant de origem. Sem tenant, vale o
  escopo da sessão, como antes. `ctx.storage.forTenant(id)` escolhe um tenant à mão (setup, job,
  plugin de administração). Mudança aditiva. O storage passa a recusar `@` no nome do plugin, que
  já não aparece em nomes kebab-case válidos.
- 5b45d43: Logger estruturado (M1-14): `createLogger(options)` sobre pino, com nível configurável (padrão
  `info`), destino injetável, `bindings` base, `child()` que acumula contexto (`plugin`, `chatId`),
  `err` serializado com `message`, `stack` e `cause`, redação de segredos por caminho (`redact`) e
  por valor (`secrets`), e `createNoopLogger()` para testes e padrões.
- b79e308: Modelo de mensagem (M1-3): `createMessage` para transports construírem mensagens normalizadas
  (com `is()`, `quoted` recursivo, mentions e flags com padrões) e `createMedia`, com
  `download()`/`stream()` lazy e cache por mensagem.
- b8d950d: Pipeline de middlewares em onion com prioridade (`MiddlewarePipeline`) e os middlewares
  oficiais: `ignoreSelf`, `rateLimit` (com expiração das janelas, via `RateLimiter`), `sanitize`
  e `chatFilter` (allow/blocklist de chats).
- 2db7d00: Objeto bruto da mensagem no escape hatch (ADR 0066).
  
  - `ctx.unsafe.raw(message)` devolve o objeto de onde a mensagem saiu, no formato da plataforma,
    como `unknown`; `undefined` se o transport não o expõe ou a mensagem não veio dele. Na mensagem
    de um clique ou de um comando nativo, é o objeto bruto da interação.
  - Mesmas regras do `native`: nunca bloqueia, e a primeira chamada de cada plugin loga um `warn`
    com plugin e transport, à parte do aviso do `native`.
  - `Transport.raw?(source: Message | Interaction)` opcional, para o transport devolver o objeto
    que guardou num `WeakMap` da instância.
  - Quem monta um `Unsafe` à mão precisa do método `raw`.
- 5ed0705: Fila de saída anti-ban (M1-12): `OutboundQueue` implementa `Sender` com intervalo mínimo global e
  por chat, prioridade `high` > `normal` > `low` (FIFO no chat), retry com backoff exponencial e
  jitter só para falhas transitórias, humanização opcional (presença `composing`/`recording`),
  limite de backlog por prioridade, `stats()` e `close({ drain })` para o shutdown. `createReply(sender, message)`
  monta o `ctx.reply` (texto e atalhos por tipo), citando a mensagem com prioridade `high`.
- ad23521: `bot.config.describe` devolve `sources`, a fonte (`default`, `override`, `file` ou `env`) de cada campo da config e de cada mensagem, e `setOverrides` loga um aviso com os campos que o arquivo ou o env sombreiam, sem os valores. Antes, um override sem efeito era salvo em silêncio.
- 5b4dbbe: `owners` aceita `{ id }` além do telefone: `createBot({ owners: ['+55 11 99999-9999', { id: '123456789012345678' }] })`.
  O `{ id }` é comparado com `sender.id` e torna possível ter dono em plataformas sem telefone
  (Discord, Telegram, web). Telefones continuam válidos como antes e nunca se cruzam com IDs. Um
  `{ id }` vazio, com espaço nas pontas ou que não é texto lança `BotConfigError` no `createBot`.
- 46718de: Papéis custom nomeados (M1-19, ADR 0035). `ctx.roles.define(nome, check)` deixa um plugin definir
  um papel que qualquer plugin exige com `role: 'nome'`, tipado por declaration merging em
  `interface Roles`. O roteador avalia: owner passa sem consultar; o `check` (com `signal` e o `log`
  do plugin dono) roda com o prazo de `timeouts.commandMs` e só `true` concede; erro, rejeição ou
  prazo estourado recusam o comando (fail-closed) e viram `plugin.error` do dono do papel, na nova
  `phase: 'role'` (`RoleTimeoutError` no prazo). Papel sem dono carregado recusa e loga erro.
  Nomes reservados lançam `TypeError` e nome já definido lança `RoleConflictError`; o papel sai no
  teardown/reload. Exporta `Roles`, `RoleName`, `RoleCheck`, `RoleContext`, `RoleConflictError` e
  `RoleTimeoutError`.
- 76e85c0: Loader e lifecycle de plugins (M1-8): `definePlugin` com config tipada pelo schema Zod e
  validação de manifesto (`name` kebab-case, `version`, `engine`, `requires`, `transports`,
  `dependsOn`); fontes da config e de `pluginDirs` (`collectPlugins` / `discoverPlugins`); ordem
  topológica por `dependsOn`/`after` com desempate por `priority` e `PluginCycleError`;
  `createPluginHost` com `disabledPlugins`, tabela de boot "carregado / ignorado (motivo)",
  `setup`/`teardown` com timeout e `reload` de um plugin; `CORE_VERSION`, `satisfies` e
  `isValidRange` (semver próprio, sem dependência nova).
- 4300338: Middleware do app ganha prazo (#239, ADR 0043). Antes, um middleware que travava segurava a fila
  do chat para sempre. Agora cada um tem `timeouts.middlewareMs` (padrão 30000), contado só no tempo
  do próprio middleware: o que roda dentro do `next()` (comando e listeners) não conta. Estourado,
  a mensagem é descartada, o `MiddlewareTimeoutError` vai para o log e o chat segue. Um `next()`
  chamado depois do prazo não roda comando nem listeners. Middleware síncrono, ou que só devolve o
  `next()`, não arma timer. O `stop()` desarma o timer de um middleware preso.
- 70489eb: Comando pode declarar o próprio prazo com `command({ timeoutMs })` (#227, ADR 0042). Ele vale para
  o `run` e o `onReject` daquele comando; sem ele, vale `timeouts.commandMs`. Um download de minutos
  não obriga mais a subir o prazo de todos os comandos. `timeoutMs` que não seja finito e > 0 falha
  no registro com `RangeError`.
- 5934191: Prazo em todo código de plugin e consulta ao transport no caminho do comando (M1-6, M1-16). O
  `onReject` passa a ter o mesmo prazo do `run` (`timeouts.commandMs`, contado à parte), com
  `signal` e `reply` presos a ele: `RejectContext` ganha `signal`, e `CommandTimeoutError` ganha
  `stage` (`'run'` ou `'onReject'`). A consulta de admin do grupo (`role: 'group-admin'`) também tem
  prazo e, estourada, rejeita com o novo `GroupAdminTimeoutError` (`plugin.error` com
  `timedOut: true`). Antes, um `onReject` ou um `getGroupMetadata` que nunca resolvia prendia o chat
  para sempre. `registry.add` (e `ctx.commands.add`) passa a validar nome e aliases como `command()`,
  lançando `TypeError` no boot em vez de registrar um comando que nunca casa.
- 7c8ca66: Prefixo de comando por tipo de chat e por chat (ADR 0063). `BotConfig.prefix` aceita também
  `{ dm, group }`, e o prefixo vazio passa a ser permitido: a primeira palavra vira o token. O novo
  `ctx.prefixes` (`get`, `set`, `reset`) troca o prefixo de um chat, gravado no storage e lido no
  boot. O roteador tira o `@usuario` da própria sessão do token, então `/start@MeuBot` de um grupo
  do Telegram roda `start`. Prefixo começado por espaço em branco agora lança `TypeError`. Tipos
  novos: `PrefixConfig` e `Prefixes`.
- 7b76631: Queda de rede nunca apaga as credenciais (#236, ADR 0045). Antes, `connection-lost`/`unknown`
  reconectavam 3 vezes (5, 10, 15 s) e depois decidiam `clean-session` (`reconnect-limit`): com
  transport por fábrica, ~30 s de rede fora apagavam o `auth` e exigiam parear de novo. Agora a
  reconexão segue com o backoff sem limite de tentativas, e `clean-session` só vem de
  `logged-out`, `auth-failed` ou `qr-limit`. **Quebra:** saem a opção
  `reconnection.maxReconnectAttempts` e a causa `'reconnect-limit'` de `ReconnectionDecision`.
- 7602730: Recarregar um plugin que provê serviço não quebra mais quem depende dele (#226, ADR 0041).
  `host.reload(x)` (e o reload por `config.setOverrides`) recarrega em cascata os plugins que
  declaram `dependsOn` em `x`, direta ou transitivamente. Eles descem antes de `x`, sobem depois e
  são reavaliados como no boot: se o `setup` novo de `x` falhar, ficam `dependency-skipped`.
  `PluginReloadResult` ganha `dependents`, e o `Bot` emite `plugin.error` também para o `setup`
  falho de um dependente.
- 02a2650: Resposta esperada: conversa com estado sem segurar o chat (ADR 0060).
  
  - `ctx.conversations.define(step, handler)` define um passo de conversa do plugin.
  - `expectReply(step, { data, ttlMs })`, nos contextos de comando, de listener de mensagem e do
    próprio passo, manda a próxima mensagem do remetente, naquele chat, ao passo. O handler pergunta,
    registra a espera e termina, sem segurar o chat na fila de entrada.
  - Há uma espera por (chat, remetente), e a última registrada substitui a anterior. Um comando
    digitado no meio da conversa cancela a espera e roda normalmente. A espera expira sem aviso
    (padrão: 5 minutos), fica em memória e é descartada no reload do plugin e no `stop()`.
  - O passo tem o prazo do comando (`StepTimeoutError`). Uma falha nele vira `plugin.error` com a
    fase nova `'step'`. Quem faz `switch` exaustivo sobre `PluginErrorEvent.phase` precisa tratar o
    valor novo.
  - Novos exports: `StepTimeoutError` e os tipos `Conversations`, `ExpectReply`,
    `ExpectReplyOptions`, `StepContext` e `StepHandler`.
- 96b55e1: A fila de saída respeita a janela que a plataforma informa e o ritmo do transport (ADR 0067).
  
  - Erro do transport com `retryAfterMs` (ms, finito e ≥ 0) re-tenta depois dessa janela exata, no
    lugar do backoff. Com `retryAfterScope: 'global'`, nenhum chat envia antes de ela abrir, mesmo
    que o envio que falhou não re-tente. Janela acima de `retry.maxDelayMs` rejeita com o erro do
    transport, sem re-tentar. A janela conta em `maxAttempts` e não muda o que é re-tentável.
  - `Transport.pacing` opcional (tipo `TransportPacing`, com `globalIntervalMs` e `chatIntervalMs`)
    dá o ritmo padrão da fila. A config do bot sobrescreve campo a campo; sem nenhum dos dois, vale
    o padrão de antes (300 ms e 1000 ms). Valor inválido no `pacing` lança `RangeError`.
  - `docs/transport.md` documenta o mapeamento das respostas da plataforma: 400, 401, 403, 404 e
    413 viram `retryable: false`, e 429 vira `retryAfterMs`.
- 6cbaffe: Cria o pacote `@usebridger/core` com os contratos compartilhados do M1: modelo de mensagem
  normalizado (tipos), `Transport` mínimo e `MessageContext`.
- 1a9a88f: Scheduler persistido (M1-11): `createSchedulerService({ storage, onError, onStorageError })`
  com `forPlugin(nome)` (`ctx.scheduler`: `at`/`on`/`cancel`, jobs no namespace do plugin),
  `removePlugin`, `start` e `stop`. Os jobs ficam em `kernelStorage(storage, 'scheduler')`,
  sobrevivem a restart e os vencidos durante o downtime disparam ao subir. Um único timer serve o
  bot inteiro. A entrega é pelo menos uma vez: o job sai do storage só depois do handler, e as
  falhas viram `plugin.error` com `phase: 'scheduler'`. Novo erro `JobHandlerConflictError`.
- 74b61e1: Service registry entre plugins (M1-9): `createServiceRegistry()` com `forPlugin(name)` (o
  `ctx.services` do plugin, com `provide`/`get`/`has` tipados por declaration merging em
  `Services`) e `removePlugin(name)` para teardown/reload. `get` de serviço ausente lança
  `ServiceNotFoundError`, e prover um nome já provido lança `ServiceConflictError` citando os
  dois plugins. `ServiceName` passa a conter só as chaves string de `Services`.
- 9536946: Escopo de sessão (M1-20, ADR 0036). `createBot({ session })` (padrão `'default'`, kebab-case)
  põe no escopo da sessão tudo o que o bot persiste: storage dos plugins, jobs do scheduler e
  overrides de config. Bots de sessões diferentes dividem um storage sem interferir; a mesma
  sessão em dois bots vivos no mesmo storage faz o `start()` do segundo rejeitar com
  `BotConfigError`, e o storage compartilhado só fecha quando o último bot para. A sessão
  `'default'` mantém o formato atual dos namespaces. Nome de plugin com `:` passa a lançar
  `ReservedNamespaceError`. `DisconnectReason` ganha `'replaced'` (conexão assumida por outra da
  mesma sessão): a `ReconnectionPolicy` decide `{ action: 'stop' }` e o bot para com erro no log,
  sem reconectar.
- 8e847ab: Adiciona o `StoragePort` completo: KV e coleções por namespace (`insert`, `get`, `find` com
  filtros `eq`/`ne`/`gt`/`gte`/`lt`/`lte`/`in`, ordenação, `limit`/`offset`, `update`, `delete`,
  índices declarados), auth state por sessão para o transport (`authState`), namespaces
  reservados ao kernel (`pluginStorage`/`kernelStorage`), o adapter em memória
  `createMemoryStorage()` e a suíte de contrato reutilizável em
  `@usebridger/core/storage-contract` (`defineStorageContract`).
- e557209: Texto formatado neutro, menções portáteis e limites de tamanho (ADR 0061).
  
  - `fmt`, `bold`, `italic`, `code`, `link` e `mention` montam um `FormattedText` que o transport
    traduz para a marcação da plataforma. `plainText` devolve o texto visível. Texto cru (string)
    continua indo como veio.
  - `ctx.reply`, a legenda dos atalhos de mídia, `ctx.send.edit` e `ctx.send.send` aceitam
    `MessageText` (string ou `FormattedText`). O `ctx.send.send` também aceita só o texto no lugar
    do conteúdo.
  - `OutgoingContent` ganha `formatted` e `formattedCaption` opcionais, com o texto visível em
    `text` e `caption`. `Transport.edit` ganha o parâmetro opcional `formatted`. Um transport que
    não conhece os campos novos envia o texto visível.
  - `Transport.limits` opcional (`text`, `caption`, `measure`). A fila de saída divide o texto e a
    legenda acima do limite em várias mensagens, sem quebrar a formatação. Só a primeira parte
    cita, e a chave devolvida é a dela. O `edit` acima do limite rejeita com `RangeError`.
  - Novos exports: `bold`, `code`, `fmt`, `italic`, `link`, `mention`, `plainText` e os tipos
    `FormattedText`, `MentionTarget`, `MessageText`, `TextLimits`, `TextNode` e `TextPart`.
- a821a90: Timeouts tipados e menos ruído no log (ADRs 0032 e 0033). O `signal` de listener e de job aborta
  com `ListenerTimeoutError` e `JobTimeoutError` (antes, um `Error` genérico); os dois e o
  `CommandTimeoutError` estendem o novo `ExecutionTimeoutError` (`plugin`, `timeoutMs`). Uma
  `ContextExpiredError` que escapa do plugin depois do prazo não é logada de novo como erro tardio,
  e a rejeição tardia de um job vai só ao log (`onLateError` em `createSchedulerService`), sem um
  segundo `plugin.error`. O logger ignora segredos com menos de `MIN_SECRET_LENGTH` (4) caracteres,
  e a config de plugin avisa, uma vez por campo, do segredo curto demais para ser censurado.
  
  A config de plugin recusa (como erro do autor, plugin ignorado no boot) `secret()` fora de campo
  de `z.object` — dentro de array, record ou union ele passava sem censura, sem máscara e aceito por
  override — e dois campos (ou chaves de `messages`) que geram a mesma variável de ambiente, como
  `openAIKey` e `openAiKey`.
- 106f17d: Transport por fábrica (M1-21, ADR 0037). `BotConfig.transport` aceita também
  `(deps: TransportDeps) => Transport`: o `createBot` chama a fábrica uma vez, sem I/O, com a
  `session`, o `auth` (`storage.authState(session)`) e um `log` filho do logger do bot
  (`{ transport: name }`, com a censura de segredos), que descarta as linhas até o `start()`.
  Fábrica que lança vira `BotConfigError` com o erro em `cause`. Com fábrica, a decisão
  `clean-session` da reconexão limpa o `auth` sem `reconnection.clearSession`, que segue como
  override. `TransportDeps` sai em `@usebridger/core/adapter`. Instâncias prontas continuam aceitas.
- 6a17ed4: Completa o contrato `Transport` (eventos normalizados, envio, reações, edição, grupos e
  presença), adiciona o registro de capabilities com `UnsupportedError`, o `TypedEmitter` para
  os adapters e a `ReconnectionPolicy` agnóstica de transport (M1-2).
- d991415: Trava de sessão entre processos (ADR 0074). Dois processos com a mesma sessão sobre o mesmo banco
  deixam de rodar juntos: o `start()` trava a sessão no storage e, com ela ocupada, espera até 30 s
  (o tempo para vencer a trava de um processo que caiu) e rejeita com `BotConfigError` antes de
  conectar. A trava é renovada a cada 10 s, liberada no `stop()`, e um bot que a perde para outro
  processo para. O `StoragePort` ganha `acquireLease?`/`releaseLease?`, opcionais só para storage
  de um processo (memória). A suíte de contrato as exige, a menos que se passe `processLocal: true`.
  O `@usebridger/storage-sqlite` as implementa numa tabela nova (`leases`, schema 2), criada sozinha
  no boot.
- 929c946: `LocationMessage.location.address`, opcional: o endereço, quando a plataforma informa (o `venue`
  do Telegram, por exemplo). Política das uniões (ADR 0069): `MessageType` e `OutgoingContent`
  continuam fechadas e podem ganhar membros numa minor, na saída sempre atrás de capability nova.
  Plugin e transport tratam `unknown` e usam `default` no `switch`, nunca o `never` exaustivo.
- e54996b: Escape hatch `ctx.unsafe.native` (M1-15): `createUnsafeAccess({ transport, log })` cria, por bot,
  a fábrica de `Unsafe`; `forPlugin(manifest)` devolve um `Unsafe` cujo `native` (`unknown`) lê o
  objeto nativo atual do transport e loga um aviso `warn` uma única vez por plugin, avisando quando
  o manifesto não declara `transports`.
- 55bda98: Vários anexos na mensagem e envio em álbum (ADR 0065).
  
  - `Message.attachments` em toda mensagem: todas as mídias, na ordem da plataforma, vazio sem
    mídia. Nos tipos de mídia, `attachments[0]` é o próprio `media`, e o `type` é o do primeiro
    anexo. O `accepts` e o `ctx.media` não mudam.
  - `Media.fileName` e `MediaSource.fileName` opcionais. O `MessageInit` aceita `attachments` como
    lista de `MediaSource`, começando pela `media`; o `createMessage` lança `TypeError` se não
    começar, ou se vier anexo num tipo sem mídia.
  - `OutgoingContent` ganha `{ type: 'album', items, caption?, formattedCaption? }`, com itens
    `image`, `video` ou `document` (tipo `AlbumItem`), e `ctx.reply.album(items, { caption })`
    (`ReplyAlbumOptions`).
  - Capability `send.album` e `limits.album`. Com a capability, a fila envia o álbum em lotes de
    até `limits.album` itens; sem ela, item a item, com a legenda no primeiro. Lote de um item sai
    como mensagem comum, e álbum vazio rejeita com `TypeError`.
  - Quem monta `Message` à mão precisa do campo `attachments`, e um transport com `switch`
    exaustivo sobre o `OutgoingContent` precisa tratar o `album`.
- 91fec63: Evento `poll.vote` (ADR 0071): o voto numa enquete chega ao plugin com
  `{ chat, messageId, sender, options, fromMe }`. `options` são os índices das opções marcadas, a
  partir de 0, com a escolha inteira de quem votou (`[]` = voto retirado). O `chatFilter`, o
  `ignoreSelf` e o `ignoreBots` valem para ele como para a `reaction`. Mudança aditiva: transports
  que não emitem o evento seguem válidos.

### Patch Changes

- 9e55135: Corrige o descarte do plugin com execuções em andamento (M1-16, ADR 0033). Antes, um reload por
  config ou o teardown deixavam vivos os comandos, listeners, jobs e checagens de papel que já
  rodavam: o `signal` deles não abortava e o `reply` seguia enviando pela fila de saída do kernel.
  Agora o descarte expira essas execuções junto com o contexto do plugin: o `signal` de cada uma
  aborta com o mesmo motivo do `ctx.signal` do plugin, e o `reply` rejeita com
  `ContextExpiredError`. Vale também no `stop()` cuja drenagem da fila de entrada estoura o prazo.
- 994259f: Docs e comentários do core sem enquadramento de WhatsApp: IDs de contato e de chat descritos como
  opacos, exemplos neutros ou de outra plataforma ao lado do WhatsApp, e o auth state explicado para
  transport por token (pode não usá-lo) e por pareamento.
- 304d0ab: Corrige `message.edited` furando as barreiras da mensagem nova (M1-16). Antes, a edição ia do
  transport direto aos listeners: chegava de chat bloqueado pelo `chatFilter`, da própria sessão
  (`ignoreSelf`), sem o `sanitize` no `text`, fora da fila do chat e antes do fim do boot. Agora
  ela entra na fila de entrada do chat, espera o boot e roda os middlewares (o `rateLimit` a conta
  como uma mensagem); se passar, vai aos listeners de `message.edited`. Edição continua sem
  disparar comando. Middlewares do app passam a ver edições e as distinguem por
  `ctx.message.isEdited`.
- 3cfe33c: O `close({ drain: false })` da fila de saída passa a alcançar o envio que está no "digitando"
  da humanização (#229). Antes, depois da espera, a fila chamava `transport.send` mesmo já
  descartada, até `humanize.maxMs` depois do shutdown, com o transport possivelmente desconectado.
  Agora a espera é encerrada e o envio rejeita com `OutboundQueueError` `'closed'`, contado em
  `dropped`, sem chegar ao transport.
- ac48966: `role: 'group-admin'` reconhece o admin também pelo telefone (#238, ADR 0046). No WhatsApp, o
  remetente pode chegar como LID e os participantes do `getGroupMetadata` como JID de telefone (ou
  o contrário): o id não batia e um admin de verdade era recusado em silêncio. Agora casa por `id`
  ou, quando os dois lados têm `phone`, pelo telefone; sem telefone de um lado, só o `id` decide.
  O contrato do `Transport` passa a documentar que ids de contato podem vir em espaços diferentes,
  que o adapter preenche `phone` sempre que souber e que `getGroupMetadata` deve ser barato (cache
  no adapter, invalidado por `group.participants`/`group.updated`).
- d6fc723: Os middlewares passam a envolver comando e listeners, como o ADR 0012 define (#225). Antes,
  o código depois de `await next()` rodava antes do comando. Agora ele roda quando comando e
  listeners terminam (ou estouram `commandMs`/`listenerMs`). Isso vale também para a edição
  (`message.edited`). Um middleware passa a medir o tratamento inteiro, a manter o "digitando"
  ou a liberar um recurso no fim.
- 2e58666: O `stop()` desarma o prazo de comando, `onReject`, checagem de papel, consulta de admin do grupo e
  listener presos (#247). Antes, o timer de um handler que nunca resolvia sobrevivia ao `stop()` por
  até 30 s: emitia `plugin.error` e log de timeout de um bot já parado e segurava o processo vivo.
- bfafe25: O QR de pareamento não sai mais inteiro no log em `info`: o aviso continua em `info` e o valor (campo `qr`) passou para `debug`. Quem lê o log (agregador, arquivo, dashboard) conseguia parear o número enquanto o QR valia. O barramento `connection.qr` segue com o valor.
- 431bed1: Scheduler com concorrência limitada (M1-11): no máximo `maxConcurrentJobs` handlers (padrão 10)
  rodam ao mesmo tempo, e os vencidos esperam vaga em ordem de `fireAt`. Antes, depois de um
  downtime longo, todos os vencidos disparavam de uma vez. A leitura dos vencidos passa a ser
  paginada, e vencidos sem handler não travam os de trás. Quando a remoção de um job falha depois
  do handler, o loop agora se rearma e o entrega de novo após `storageRetryMs`; antes, ele ficava
  parado no storage até outro evento acordar o loop.
- 05b9d9c: Scheduler: jobs sem handler (plugin desligado, job renomeado) saem das consultas do loop. Antes eram relidos do storage a cada disparo, e o custo crescia com o acúmulo; agora também não armam timer (#228).
- c235aea: Corrige o shutdown do `Bot` (M1-16): nada do bot sobrevive ao `stop()`. Antes, com o prazo total
  esgotado, os ganchos do scheduler e da fila de saída eram pulados e o timer do scheduler seguia
  rearmando contra o storage já fechado, segurando o processo vivo. Agora, depois dos ganchos, o bot
  abandona o que restou: solta os eventos do transport, para a reconexão, descarta o que aguarda
  nas filas, abandona os jobs em andamento (que ficam no storage para a próxima subida) e o
  `teardown` em curso, e faz o `dispose` de todos os plugins. O scheduler passa a parar antes do
  `teardown` dos plugins, e os prazos dos ganchos internos passam a somar o total padrão (15 s).
  `stop()` durante o `setup` dos plugins não conecta mais o transport. `InboundQueue.close`
  aceita `{ drain: false }`, e `SchedulerService.stop` e `PluginHost.stop` aceitam um
  `AbortSignal` que abandona o trabalho em curso.
- fdd868d: `CORE_VERSION` deixa de ser mantida à mão: `pnpm version-packages` roda o `changeset version` e
  reescreve a constante com a versão nova do `package.json`, para o PR de versão não sair com o
  `engine` conferido contra a versão antiga. A doc de plugins passa a dizer qual `engine` declarar
  durante o 0.x (`>=0.1.0 <1.0.0` no monorepo, `^0.M.0` fora dele) e por que `^0.0.x` quebra no
  primeiro bump.
- 5c864c2: O projeto se chama Bridger, com os pacotes no escopo `@usebridger/*` e o scaffold `create-bridger-plugin` (ADR 0083). A config de plugin lê variáveis com prefixo `BRIDGER_`, a anotação de campo não editável por override é `x-bridger-override`, plugins seguem o prefixo `bridger-plugin-` e o schema Postgres padrão é `bridger`. O repositório passa a ser `murillous/usebridger`.
- a8482ee: Metadados de publicação no `package.json`: `repository` (com a pasta do pacote), `homepage`, `bugs` e acesso público. As dependências entre pacotes `@usebridger/*` passam a sair como `^<versão>` em vez da versão exata.
