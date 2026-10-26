# ADRs do Bridger

Registros de decisão de arquitetura (o PORQUÊ) do kernel. O código e as docs citam a decisão como
`DNN` (= `ADR 00NN`).
Os ADRs do LumaBot atual continuam em [`legacy/docs/adr/`](https://github.com/murillous/LumaBot/tree/main/legacy/docs/adr).

## Formato

Um arquivo por decisão, `NNNN-slug.md`, com:

- **Status** — `Proposto`, `Aceito`, `Substituído por ADR NNNN` ou `Descontinuado`;
- **Contexto** — o problema, as forças e as alternativas consideradas;
- **Decisão** — o que foi decidido;
- **Consequências** — o que muda, o que fica mais fácil e o que fica mais caro.

ADRs aceitos não são reescritos: uma mudança de decisão vira um ADR novo que substitui
o anterior, e o antigo passa a apontar para ele no Status.

## Índice

Um ADR novo entra no fim da lista.

- [0001](0001-typescript-no-kernel.md) — TypeScript no kernel, publicado com `.d.ts`
- [0002](0002-transport-abstrato.md) — `Transport` abstrato, só Baileys na v1
- [0003](0003-uma-sessao-por-processo.md) — Uma sessão por processo, zero estado global
- [0004](0004-plugins-no-mesmo-processo.md) — Plugins no mesmo processo, isolados por try/catch + timeout
- [0005](0005-plugins-via-npm-e-pasta.md) — Plugins via npm e via pasta (`pluginDirs`)
- [0006](0006-sem-hot-reload.md) — Sem hot-reload de código na v1
- [0007](0007-modelo-de-mensagem-normalizado.md) — Modelo de mensagem normalizado
- [0008](0008-capabilities-do-transporte.md) — Capabilities do transporte + `requires`
- [0009](0009-escape-hatch-unsafe-native.md) — Escape hatch `ctx.unsafe.native`
- [0010](0010-pipeline-de-3-estagios.md) — Pipeline de 3 estágios
- [0011](0011-escopo-do-core.md) — Escopo do core
- [0012](0012-storage-port-sqlite-postgres.md) — `StoragePort` com SQLite e Postgres na v1; auth state no port
- [0013](0013-storage-kv-e-colecoes.md) — Storage: KV com namespace + coleções
- [0014](0014-manifesto-do-plugin.md) — Manifesto do plugin
- [0015](0015-config-por-plugin-zod.md) — Config por plugin com Zod 4
- [0016](0016-service-registry.md) — Service registry entre plugins
- [0017](0017-fila-de-saida-anti-ban.md) — Fila de saída anti-ban no core
- [0018](0018-http-unico-hono.md) — Servidor HTTP único no core (Hono)
- [0019](0019-dashboard-vira-plugin.md) — Dashboard vira plugin (rotas e auth substituídas pelo 0125)
- [0020](0020-kit-de-autor.md) — Kit de autor na v1
- [0021](0021-papeis-no-core.md) — Papéis no core
- [0022](0022-sem-i18n-objeto-messages.md) — Sem i18n formal na v1; objeto `messages`
- [0023](0023-tooling.md) — Tooling: Node 24, pnpm, tsdown, Vitest, Biome
- [0024](0024-releases-changesets.md) — Releases com Changesets
- [0025](0025-licenca-apache-2.md) — Licença Apache-2.0
- [0026](0026-open-core-repo-privado.md) — Open core com repo privado
- [0027](0027-metas-de-performance.md) — Metas de performance com benchmark no CI
- [0028](0028-camadas-da-config-de-plugin.md) — Camadas e convenções da config de plugin
- [0029](0029-cancelamento-cooperativo.md) — Cancelamento cooperativo do código de plugin
- [0030](0030-biblioteca-sem-runner.md) — Bridger é uma biblioteca, sem runner
- [0031](0031-papeis-nomeados-por-plugin.md) — Papéis custom nomeados, definidos por plugin
- [0032](0032-escopo-de-sessao.md) — Escopo de sessão no bot e no storage
- [0033](0033-transport-por-fabrica.md) — Transport recebe as dependências do bot por fábrica
- [0034](0034-filtro-de-eventos-no-kernel.md) — chatFilter e ignoreSelf valem para os eventos que não são mensagem
- [0035](0035-fila-de-saida-e-conexao.md) — Fila de saída pausa com a conexão caída e tem prazo por envio
- [0036](0036-acoes-do-transport-no-plugin.md) — Ações e leituras do transport chegam ao plugin pela API pública
- [0037](0037-reload-em-cascata.md) — Reload de plugin em cascata pelos dependentes
- [0038](0038-handler-lento-segura-o-chat.md) — Comando e listener lentos seguram o chat
- [0039](0039-prazo-de-middleware.md) — Middleware do app tem prazo
- [0040](0040-espera-pelo-bot-assentar.md) — `bot.settled()` espera o bot processar o que recebeu
- [0041](0041-queda-de-rede-nao-limpa-sessao.md) — Queda de rede nunca limpa a sessão
- [0042](0042-ids-de-contato-e-metadata-de-grupo.md) — Ids de contato em espaços diferentes e custo do `getGroupMetadata`
- [0043](0043-espera-na-fila-de-saida-fora-do-prazo.md) — A espera na fila de saída não conta no prazo do handler
- [0044](0044-connect-resolve-ao-iniciar.md) — `connect()` resolve ao iniciar a tentativa; queda antes do fim não se perde
- [0045](0045-evento-de-comando.md) — Evento `command`: o plugin observa o comando que consumiu a mensagem
- [0046](0046-codigo-de-pareamento.md) — Código de pareamento chega por evento, como o QR
- [0047](0047-sqlite-via-node-sqlite.md) — SQLite pelo `node:sqlite`, com schema único e migrations do adapter
- [0048](0048-kit-de-testes-sobre-o-vitest.md) — Kit de testes sobre o Vitest, com `receive()` que espera o bot assentar
- [0049](0049-core-testa-sem-o-kit.md) — O core se testa com apoios próprios, não com o `@usebridger/testing`
- [0050](0050-baseline-do-benchmark.md) — Baseline do benchmark medido no mesmo job, a partir do commit base
- [0051](0051-plataformas-alvo-e-transport-web.md) — Plataformas-alvo e um transport fora do WhatsApp antes do 1.0
- [0052](0052-owners-por-telefone-ou-id.md) — Owners por telefone ou por ID do contato
- [0053](0053-contact-multiplataforma.md) — `Contact` multiplataforma: `username`, `isBot` e claims verificados
- [0054](0054-chat-multiplataforma.md) — `Chat` multiplataforma: tipo, espaço e título
- [0055](0055-grupos-multiplataforma.md) — Grupos multiplataforma: admin, participantes, ações e eventos
- [0056](0056-resposta-esperada.md) — Resposta esperada: conversa com estado sem segurar o chat
- [0057](0057-texto-formatado-neutro.md) — Texto formatado neutro, menções portáteis e limites de tamanho
- [0058](0058-acoes-e-botoes.md) — Ações e botões: o clique dispara um comando, com fallback em texto numerado
- [0059](0059-prefixo-por-chat.md) — Prefixo por tipo de chat e por chat, vazio permitido
- [0060](0060-comandos-nativos.md) — Comandos nativos: o transport lê a lista e confirma a interação na hora
- [0061](0061-varios-anexos-e-albuns.md) — Vários anexos na mensagem e envio em álbum
- [0062](0062-objeto-bruto-da-mensagem.md) — Objeto bruto da mensagem no `ctx.unsafe.raw()`
- [0063](0063-retry-after-e-ritmo-do-transport.md) — Janela da plataforma no retry e ritmo padrão do transport
- [0064](0064-desconexao-fatal-e-transport-sem-pareamento.md) — Desconexão fatal e transport sem pareamento
- [0065](0065-unioes-de-tipo-antes-do-1-0.md) — Uniões de tipo de mensagem e de conteúdo antes do 1.0
- [0066](0066-capabilities-multiplataforma.md) — Capabilities multiplataforma: `typing`, reações, enquetes e a lista do core
- [0067](0067-voto-em-enquete.md) — Voto em enquete: o evento `poll.vote`
- [0068](0068-isolamento-por-tenant.md) — Isolamento automático por tenant
- [0069](0069-kit-de-testes-multiplataforma.md) — Kit de testes multiplataforma: perfis de transport
- [0070](0070-trava-de-sessao-entre-processos.md) — Trava de sessão entre processos
- [0071](0071-varios-bots-e-escopo-compartilhado.md) — Vários bots num storage e escopo compartilhado opt-in
- [0072](0072-http-do-core.md) — HTTP do core: um servidor por processo, rotas de plugin e de transport por sessão (sem auth no kernel: substituído pelo 0125 na API)
- [0073](0073-transport-web.md) — `@usebridger/transport-web`: chat por WebSocket com JWT, conversa por usuário e mídia por HTTP
- [0074](0074-postgres-via-pg.md) — Postgres pelo `pg`, com schema próprio, documentos em `jsonb` e migrations do adapter
- [0075](0075-acucar-no-manifesto-do-plugin.md) — Açúcar no manifesto do plugin: `commands`, `on` e o `run` que devolve texto
- [0076](0076-acucar-para-o-autor-de-transport.md) — Açúcar para o autor de transport: `defineTransport` e coerência no `createBot`
- [0077](0077-create-bridger-plugin.md) — `create-bridger-plugin`: scaffold sem dependências, template na forma curta e aceite por e2e
- [0078](0078-release-a-partir-de-develop.md) — Release a partir de `develop`, com Trusted Publishing no npm e PR de versão aberto por um GitHub App
- [0079](0079-nome-bridger.md) — Nome: Bridger, no escopo `@usebridger`
- [0080](0080-repositorios-separados.md) — Kernel e LumaBot em repositórios separados
- [0081](0081-release-a-partir-da-main.md) — Release a partir da `main`, com `develop` como integração
- [0082](0082-plugins-da-luma-no-lumabot.md) — Plugins da Luma no LumaBot
- [0083](0083-comando-em-segundo-plano.md) — Comando em segundo plano: `background: true`
- [0084](0084-limite-de-concorrencia-por-comando.md) — Limite de concorrência por comando: `concurrency`
- [0085](0085-benchmark-intercalado.md) — Benchmark intercalado: base e commit testado se revezam, comparados pelo quartil bom
- [0086](0086-requires-por-comando.md) — `requires` por comando
- [0087](0087-log-legivel-e-baileys-em-warn.md) — Log legível no terminal e Baileys a partir de `warn`, com o libsignal
- [0088](0088-placeholders-nas-messages.md) — Placeholders nas `messages` e `ctx.t`
- [0089](0089-react-do-contexto-tolerante.md) — `react` do contexto tolerante à falta da capability
- [0090](0090-accepts-estreita-o-contexto-e-args.md) — `accepts` estreita o contexto do `run` e ganha `'args'`
- [0091](0091-zod-no-subpath-do-core.md) — Zod do core no subpath `@usebridger/core/zod`
- [0092](0092-pontos-de-extensao-em-servicos.md) — Pontos de extensão em serviços
- [0093](0093-onexpire-do-passo.md) — `onExpire` no passo: reagir à espera que venceu
- [0094](0094-esperas-persistidas.md) — Esperas do `expectReply` persistidas por passo
- [0095](0095-comando-que-exige-servico.md) — Comando que exige serviço e `optionalDependsOn`
- [0096](0096-mencao-com-tag-no-texto.md) — Menção com `tag` no texto e `textWithMentionNames`
- [0097](0097-nomes-de-contatos-no-auth-state.md) — Nomes de contatos no auth state
- [0098](0098-plugin-falho-derruba-o-boot.md) — Plugin incompatível ou com `setup` falho derruba o boot
- [0099](0099-site-de-documentacao.md) — Site de documentação com Starlight
- [0100](0100-jobs-recorrentes.md) — Jobs recorrentes: `scheduler.every`
- [0101](0101-incremento-atomico-na-colecao.md) — Incremento atômico na coleção
- [0102](0102-observadores-do-core.md) — Observadores do core e `ctx.stats()`
- [0103](0103-plugins-oficiais-de-metricas-e-dashboard.md) — Plugins oficiais de métricas e dashboard
- [0104](0104-abas-do-dashboard-por-ponto-de-extensao.md) — Abas do dashboard por ponto de extensão (substituído pelo 0125)
- [0105](0105-sinal-de-log-nos-observadores.md) — Sinal `log` nos observadores
- [0106](0106-sessao-e-status-de-conexao-no-contexto.md) — Sessão e último status de conexão no contexto do plugin
- [0107](0107-acesso-admin-para-plugins.md) — Acesso admin para plugins autorizados
- [0108](0108-tabela-de-plugins-com-dependencias-servicos-e-contribuicoes.md) — Tabela de plugins com dependências, serviços e contribuições
- [0109](0109-contrato-das-abas-do-dashboard-complemento.md) — Complementos ao contrato das abas do dashboard (substituído pelo 0125)
- [0110](0110-duracao-do-setup-contagem-e-boot-no-report-de-plugins.md) — Duração do setup, contagem por ponto e horário do boot no report de plugins
- [0111](0111-status-do-bot-no-contexto.md) — Status do bot no contexto: no ar desde, reconexões, expiração do QR e nome
- [0112](0112-servico-com-escopo-por-chamador.md) — Serviço com escopo por quem chama
- [0113](0113-gauge-e-fila-de-saida-nas-metricas.md) — Gauge no serviço `metrics` e a fila de saída
- [0114](0114-titulo-tom-e-rotulo-nos-widgets-das-abas.md) — Título, tom e rótulo de envio nos widgets das abas (substituído pelo 0125)
- [0115](0115-testes-de-componente-do-dashboard-no-happy-dom.md) — Testes de componente do dashboard no happy-dom
- [0116](0116-giveup-da-reconexao-leva-ao-estado-failed.md) — O giveUp da reconexão leva o bot ao estado `failed`
- [0117](0117-segredos-cifrados-editaveis-pelo-dashboard.md) — Segredos cifrados no storage, editáveis pelo dashboard
- [0118](0118-contrato-de-log-estruturado.md) — Contrato de log estruturado: `event` estável, campos padronizados e formato para o Loki
- [0119](0119-pseudonimo-estavel-nos-logs.md) — Pseudônimo estável do usuário nos logs
- [0120](0120-trace-e-trilha-de-eventos.md) — Trace de correlação e trilha de eventos por unidade de trabalho
- [0121](0121-plugin-metrics-sobre-o-prom-client.md) — `plugin-metrics` redesenhado sobre o `prom-client`
- [0122](0122-log-de-auditoria-no-kernel.md) — Log de auditoria no kernel (`ctx.audit`): ator do contexto, fila com back-pressure e cadeia de hash
- [0123](0123-redacao-de-details-por-sufixo.md) — Redação dos `details` da auditoria por sufixo (`accessToken`, `clientSecret`)
- [0124](0124-template-e-janela-de-atendimento.md) — Template e janela de atendimento (`send.template`, `ConversationWindowError`, `ctx.send.window`)
- [0125](0125-api-http-do-core-e-dashboard-cliente.md) — API HTTP do core em OpenAPI, auth no core, SSE e dashboard como cliente (`api.resources`)
- [0126](0126-rotas-da-api-de-plugin-sob-api-plugins.md) — Operações de plugin na API ficam em `/api/plugins/<nome>`; spec do core em snapshot de arquivo
