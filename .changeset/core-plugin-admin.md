---
"@usebridger/core": minor
---

`ctx.admin` (`{ plugins, config }`) no contexto dos plugins listados em `createBot({ adminPlugins })`; os demais recebem `undefined`. Reload, disable e `setOverrides` sobre o próprio plugin rejeitam (ADR 0111). Exporta `PluginHostStateError`, o erro de estado do host (ex.: plugin desconhecido, ação sobre si mesmo), para quem precisa distingui-lo.
