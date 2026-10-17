---
"@usebridger/core": minor
---

`ctx.admin` (`{ plugins, config }`) no contexto dos plugins listados em `createBot({ adminPlugins })`; os demais recebem `undefined`. Reload, disable e `setOverrides` sobre o próprio plugin rejeitam (ADR 0111).
