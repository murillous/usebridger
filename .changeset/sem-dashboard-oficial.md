---
"@usebridger/core": patch
"create-bridger-plugin": patch
---

Docs e template sem o `plugin-dashboard` (ADR 0138): o Bridger deixa de publicar dashboard, e cada app monta o seu painel sobre a API HTTP do core e a spec em `GET /openapi.json`. O `@usebridger/plugin-dashboard` fica `deprecated` no npm, nas versões já publicadas.
