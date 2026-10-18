---
"@usebridger/core": minor
---

`ctx.admin` (`{ plugins, config }`) no contexto dos plugins listados em `createBot({ adminPlugins })`; os demais recebem `undefined`. Reload, disable e `setOverrides` sobre o próprio plugin rejeitam (ADR 0111). `PluginConfigIssue` ganha `kind: 'secret' | 'invalid'`. O que sai pelo `ctx.admin` (retornos e erros) tem os segredos do bot mascarados. Exporta `PluginHostStateError`, o erro de estado do host (ex.: plugin desconhecido, ação sobre si mesmo), para quem precisa distingui-lo.
