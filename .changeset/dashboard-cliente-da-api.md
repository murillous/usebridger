---
'@usebridger/plugin-dashboard': minor
---

Quebra (M7-10, ADR 0125): o dashboard foi refeito como cliente genérico da API HTTP do core. O
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
