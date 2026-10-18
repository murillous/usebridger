# @usebridger/plugin-dashboard

## 0.1.0

### Minor Changes

- 64f30e7: Abas contribuídas por plugins pelo ponto `dashboard.tabs` (ADR 0108): `GET /api/tabs`, `GET /api/tabs/:plugin/:tab/:widget`, `POST .../actions/:action` e `POST .../submit`; widgets `stats`, `table`, `series`, `form` e `text`; grupo Extensões na sidebar e em Mais no celular. Exporta os tipos `DashboardTab`, `DashboardWidget` e afins.
- 678e1fb: App web do dashboard (React + Vite) servido pelo próprio plugin em `GET /` e `/*`, com fallback de SPA e `<base href>` do `basePath`: Login, Visão geral (status, QR, código de pareamento, indicador ao vivo), Logs, Plugins e Config (formulário gerado do JSON Schema). Os estáticos saem em `dist/web` no `pnpm build`.
- c61f21d: API de config dos plugins: `GET`/`PUT /api/config/:plugin` devolvem view (secrets mascarados) e JSON Schema, e gravam overrides com validação e reload; exige `adminPlugins` (M5-4.2).
- 1c52dfc: `GET /api/logs` aceita `?level=<nível>` e devolve só as linhas com nível igual ou acima; nível inválido responde 400.
- 7c142d8: Tela Métricas (painéis do kernel e seção com toda métrica registrada no serviço `metrics`), KPIs do dia na Visão geral e destino Métricas na TabBar do celular. Nova rota `GET /api/metrics?days=N`; o `plugin-metrics` é opcional e, sem ele, a tela explica como instalar.
- f65c4fa: Plugins: colunas setup, `dependsOn`, serviços e contribuições. Config: lista de plugins ao lado no desktop (`select` só abaixo de 768 px), lista editável para array de primitivos e pares chave/valor para record.
- 786a0d4: `GET /api/plugins` (tabela de boot) e `POST /api/plugins/:name/enable|disable|reload`, só com `dashboard` em `adminPlugins` (503 sem isso).
- d79e8af: `GET /api/status` e o snapshot do WebSocket trazem `session`; o status parte do último estado de conexão guardado pelo core, então reflete a conexão atual depois de um reload do plugin.
- 56fb75d: Novo pacote `@usebridger/plugin-dashboard`: base do dashboard (ADR 0107) com login por token e cookie de sessão HttpOnly, `GET /api/status`, `GET /api/logs` (buffer em anel alimentado pelo sinal `log`) e WebSocket `/api/ws` com snapshot e push de status, QR, código de pareamento e logs.

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
