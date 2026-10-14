---
'@usebridger/core': minor
---

Pontos de extensão em serviços: `ctx.services.contribute(name, contribuicao)` acrescenta uma contribuição atribuída ao plugin, que sai sozinha no teardown, reload e disable dele, e `ctx.services.extensionPoint(name).list()` devolve as contribuições de todos os plugins, na ordem de carga. O tipo vem de declaration merging na nova interface `ExtensionPoints` (tipos `ExtensionPoint`, `ExtensionPointName` e `ExtensionPoints` exportados). O serviço extensível deixa de precisar do `ctx.signal` de quem contribui (ADR 0096).
