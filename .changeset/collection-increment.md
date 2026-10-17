---
'@usebridger/core': minor
'@usebridger/storage-sqlite': minor
'@usebridger/storage-postgres': minor
---

`Collection.increment(where, field, by?, { insert }?)`: contador atômico, sem a corrida ler-alterar-gravar. Soma ao campo numérico dos documentos que casam; com `insert`, cria o documento quando nenhum casa, sem duplicar sob concorrência. O core exporta `normalizeIncrement` e `incrementedValue` em `@usebridger/core/adapter` para os adapters. Adapter de storage de terceiros precisa implementar `Collection.increment`.
