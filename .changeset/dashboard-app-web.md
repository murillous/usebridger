---
"@usebridger/plugin-dashboard": minor
---

App web do dashboard (React + Vite) servido pelo próprio plugin em `GET /` e `/*`, com fallback de SPA e `<base href>` do `basePath`: Login, Visão geral (status, QR, código de pareamento, indicador ao vivo), Logs, Plugins e Config (formulário gerado do JSON Schema). Os estáticos saem em `dist/web` no `pnpm build`.
