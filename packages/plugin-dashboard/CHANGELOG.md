# @usebridger/plugin-dashboard

## 0.4.0

### Minor Changes

- 227bd98: Logs pelo contrato do ADR 0118 (#230): cada linha sai com `event` (`baileys.*`, `web.*`, `dashboard.*`, `metrics.*`, e `transport.handler.failed` nos dois transports), mensagem fixa e os valores em campos. O `plugin-dashboard` deixa de escrever o prefixo `dashboard:` na mensagem (o binding `plugin` já diz de onde vem), e o `plugin-metrics` passa a logar o erro em `err`, com mensagem e stack. A lista dos eventos está em `docs/log-events.md` do core.
  
  No `metrics.prometheus.name-collision`, o campo `name` passa a `metric`. Os pacotes usam `log.event`, que existe a partir do `@usebridger/core` 0.10.0: use o core 0.10.0 ou mais novo (nos quatro pacotes, a dependência já sai como `^0.10.0`).
- 3aed49c: Quebra (M7-10, ADR 0125): o dashboard foi refeito como cliente genérico da API HTTP do core. O
  plugin só serve o app web; não tem mais rota de dados, auth nem config próprias.
  
  - Saem a config (`token`, `logBufferSize`, `cookieMaxAgeSec`), as rotas `/plugins/dashboard/api/*`
    (login por token, status, logs, WebSocket, plugins, config, abas), o ponto `dashboard.tabs` e os
    tipos `DashboardTab`, `DashboardWidget`, `TableColumn` e afins. O acesso passa a ser o da API
    (`api.auth`, login por e-mail e senha, papéis e permissões), e o `adminPlugins: ['dashboard']`
    deixa de ser necessário. Abas viram `api.resources`.
  - Telas novas: login e aceite de convite (com o primeiro acesso pelo `bootstrapToken`), conexão com
    QR e código de pareamento ao vivo, logs (histórico com filtros e ao vivo pelo SSE), plugins,
    config gerada do JSON Schema pelo `@rjsf`, métricas (com o `plugin-metrics`), auditoria, usuários,
    API keys, minha conta e uma tela genérica para qualquer recurso de `api.resources`. A navegação e os
    botões seguem as permissões de `GET /auth/me`.
- 5d14b77: Remove a seção de métricas do dashboard até a reescrita da M7: sai a rota `GET /api/metrics`, a
  tela Métricas, os KPIs de hoje da Visão geral e a entrada Métricas da navegação, e o evento de log
  `dashboard.metrics.read-failed`. O dashboard não importa mais o `@usebridger/plugin-metrics`. O
  resto (QR, status, logs, config, plugins e abas) segue igual.

### Patch Changes

- a36bc23: Documentação revisada contra o código: páginas e comentários da API sem referências internas de decisão, mais exemplos e as lacunas preenchidas (Telegram, referência de mídia, rotas da API, eventos de log).
- 0a4c8cd: Logger: um `Error` em qualquer chave dos campos (`{ error }`) sai serializado como o `err`, com `type`, `message`, `stack` e `cause`, em vez de `{}`; no formato `pretty`, vai para as linhas seguintes com o nome do campo. O `plugin-dashboard` passa a logar os erros em `{ err }`.
- Updated dependencies [9a3a657]
- Updated dependencies [f4316ad]
- Updated dependencies [1d4cb96]
- Updated dependencies [aabf039]
- Updated dependencies [227bd98]
- Updated dependencies [184c8cb]
- Updated dependencies [87041b4]
- Updated dependencies [0b340df]
- Updated dependencies [18c56f3]
- Updated dependencies [cc35cbb]
- Updated dependencies [ede77ef]
- Updated dependencies [ae1e2b9]
- Updated dependencies [1c176d8]
- Updated dependencies [f7f5501]
- Updated dependencies [14c3f0c]
- Updated dependencies [b8b6b6e]
- Updated dependencies [6ab377b]
- Updated dependencies [0889b0c]
- Updated dependencies [a36bc23]
- Updated dependencies [48d7580]
- Updated dependencies [0a4c8cd]
- Updated dependencies [3cc14d5]
- Updated dependencies [abc53c7]
- Updated dependencies [48ceea9]
- Updated dependencies [e0bcb8b]
- Updated dependencies [ab54782]
- Updated dependencies [25b0caa]
- Updated dependencies [b7359b5]
- Updated dependencies [6681792]
- Updated dependencies [925a198]
  - @usebridger/core@0.10.0

## 0.3.0

### Minor Changes

- 1f3db10: Config e `form` das abas: `z.array(z.object({...}))` com campos simples vira um editor de lista com um bloco por item e botões para subir, descer, remover e adicionar, no lugar do JSON cru. Erro do servidor num item aparece junto da lista.

### Patch Changes

- 01f4b9e: A tela de Config lista só os plugins que declaram `config`; os sem schema saem da lista.
- b5dd608: Sidebar fixa durante o scroll da página, conteúdo principal centralizado e tabela de plugins com scroll próprio, mantendo os switches de ativar/desativar sempre dentro do card.

## 0.2.0

### Minor Changes

- a784db1: Status do bot no contexto (M5-4.8): `ctx.connectionInfo()`, `ctx.botName`, `BotConfig.name` e `expiresAt` opcional em `connection.qr` (preenchido pelo Baileys). O card do bot na Visão geral mostra "No ar desde", Reconexões e "Expira em", o cabeçalho mostra o nome do bot, e o botão Copiar volta ao normal depois de uma falha.
- 7996b2a: Visão geral ganha o 5º KPI "Fila de saída", ao vivo pelo status (`outboundPending`), e Métricas troca "Envios por dia" pelo painel da fila de saída (máximo por dia, gauge). A coluna "Plugin" mostra o dono de cada métrica (`core` para o kernel), `GET /api/metrics` devolve `plugin` por métrica e a contagem de séries passa a ficar no texto, ao lado do nome.
- b67d9ca: Tela de plugins conforme o canvas (M5-4.8): nome e versão numa coluna, estado carregado/falhou/pulado/desligado, toggle de ativo, busca, subtítulo do boot, painel com a causa real do erro de setup (`reason.causeMessage`, com secrets censurados) e, no mobile, filtros, card de problema e lista com toggle. Nova rota `GET /api/plugins/boot`. A tabela deixa de estourar a largura em 1080 px.
- 2ea098c: A Config substitui e remove segredos cifrados (ADR 0117): rotas `PUT` e `DELETE /api/config/:plugin/secrets/:path`, `secretsWritable` no manifesto e botões "Substituir" e "Remover" nos campos secretos.
- 416395d: Abas de plugin (`dashboard.tabs`): todo widget aceita `title?` (antes só `series`), desenhado sobre o widget e usado como rótulo da seção; `StatItem` ganha `tone?` (`ok`, `warn`, `danger`), que colore o valor do cartão; e o `form` ganha `submitLabel?` para o texto do botão de envio (padrão "Enviar"). Título ou rótulo que não é texto some do manifesto, e tom desconhecido some do item sem descartá-lo (ADR 0114).

### Patch Changes

- 7ca5336: Rótulos da Config pelo `title` do schema (fallback `description`, depois o nome com inicial maiúscula), placeholder por `examples[0]`, campo de data e hora para `format: 'date-time'` e "Abrir config" da lista de plugins levando ao plugin certo (`#/config/<plugin>`).
- 986cfc1: Página Plugins: a coluna "Depende de" lista também as dependências opcionais, marcadas com `?` (ex.: `metrics?`), em vez de mostrar "—".
- 69c4de1: Página Plugins: o erro de ativar, desativar ou recarregar (ex.: `409: …`) continua visível depois que a lista recarrega, em vez de sumir na hora.
- a1c4705: Dashboard: ajustes de layout da verificação. KPIs da Visão geral em uma linha no desktop, tabela de Plugins sem quebra no meio de palavras, sidebar com "de plugins" e o dono de cada aba, sem o selo "Ao vivo" duplicado em Logs e "Expira em" do QR no formato `m:ss`.
- 2f7aa49: Tela de Configuração conforme o canvas: cabeçalho com o caminho da config, badges de erro e falha na lista de plugins, chips e origem real do secret, dica de tipo do schema, campos numéricos lado a lado e barra de salvar dentro do card com o aviso do reload em cascata.
- 7f20064: Visão geral do app web conforme o canvas: card por bot com chip de estado, QR e código de pareamento, card de erro fatal com "Abrir config", seção "Hoje" com 4 KPIs (Fila de saída aguarda o core) e "Logs recentes".
- d2ac4e5: Shell do app web conforme o canvas: marca com "dashboard", seletor de sessão, rótulos "Visão geral" e "Configuração", rodapé com as versões do core e do dashboard, cabeçalho com selo de tempo relativo, "Pausar atualização" e botão de tema. O status do dashboard passa a trazer `versions`.
- 711d79e: Plugins mostra a duração do setup (`OK · 18 ms`) e as contribuições por ponto (`dashboard.tabs ×5`), usa o horário real do boot do core e não deixa o subtítulo com sufixo vazio. O aviso de dependentes da Config conta também os dependentes opcionais.
- b9d87b9: Métricas e abas contribuídas por plugin conforme o canvas: período 7/30/90 dias em controle segmentado, quatro painéis do kernel com valor de hoje e eixo "12 out … hoje", tabela de todas as métricas com rótulos e colunas Hoje e N dias, link para copiar o scrape; na aba de plugin, "Contribuída por … via dashboard.tabs", voltar para Mais com chevron, tabela em card e linha de lista com a ação ao lado.
- Updated dependencies [f707794]
- Updated dependencies [c26a895]
- Updated dependencies [201c06a]
- Updated dependencies [c095ec7]
- Updated dependencies [5ef42f6]
- Updated dependencies [a784db1]
  - @usebridger/core@0.9.0

## 0.1.0

### Minor Changes

- 64f30e7: Abas contribuídas por plugins pelo ponto `dashboard.tabs` (ADR 0104): `GET /api/tabs`, `GET /api/tabs/:plugin/:tab/:widget`, `POST .../actions/:action` e `POST .../submit`; widgets `stats`, `table`, `series`, `form` e `text`; grupo Extensões na sidebar e em Mais no celular. Exporta os tipos `DashboardTab`, `DashboardWidget` e afins.
- 678e1fb: App web do dashboard (React + Vite) servido pelo próprio plugin em `GET /` e `/*`, com fallback de SPA e `<base href>` do `basePath`: Login, Visão geral (status, QR, código de pareamento, indicador ao vivo), Logs, Plugins e Config (formulário gerado do JSON Schema). Os estáticos saem em `dist/web` no `pnpm build`.
- c61f21d: API de config dos plugins: `GET`/`PUT /api/config/:plugin` devolvem view (secrets mascarados) e JSON Schema, e gravam overrides com validação e reload; exige `adminPlugins` (M5-4.2).
- 1c52dfc: `GET /api/logs` aceita `?level=<nível>` e devolve só as linhas com nível igual ou acima; nível inválido responde 400.
- 7c142d8: Tela Métricas (painéis do kernel e seção com toda métrica registrada no serviço `metrics`), KPIs do dia na Visão geral e destino Métricas na TabBar do celular. Nova rota `GET /api/metrics?days=N`; o `plugin-metrics` é opcional e, sem ele, a tela explica como instalar.
- f65c4fa: Plugins: colunas setup, `dependsOn`, serviços e contribuições. Config: lista de plugins ao lado no desktop (`select` só abaixo de 768 px), lista editável para array de primitivos e pares chave/valor para record.
- 786a0d4: `GET /api/plugins` (tabela de boot) e `POST /api/plugins/:name/enable|disable|reload`, só com `dashboard` em `adminPlugins` (503 sem isso).
- d79e8af: `GET /api/status` e o snapshot do WebSocket trazem `session`; o status parte do último estado de conexão guardado pelo core, então reflete a conexão atual depois de um reload do plugin.
- 56fb75d: Novo pacote `@usebridger/plugin-dashboard`: base do dashboard (ADR 0103) com login por token e cookie de sessão HttpOnly, `GET /api/status`, `GET /api/logs` (buffer em anel alimentado pelo sinal `log`) e WebSocket `/api/ws` com snapshot e push de status, QR, código de pareamento e logs.

### Patch Changes

- Updated dependencies [d79e8af]
- Updated dependencies [bf58cef]
- Updated dependencies [59f6646]
- Updated dependencies [9ad8550]
- Updated dependencies [740fed1]
- Updated dependencies [f65c4fa]
- Updated dependencies [97642b6]
- Updated dependencies [8232a57]
- Updated dependencies [36a9796]
  - @usebridger/core@0.8.0
