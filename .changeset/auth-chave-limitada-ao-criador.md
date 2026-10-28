---
'@usebridger/core': minor
---

A permissão efetiva de uma API key passa a ser o escopo dela limitado às permissões atuais do criador
(`createdBy`, M7-4, ADR 0128): criador rebaixado perde permissões na chave; desativado ou inexistente,
a chave dá 401; reativar restaura. A chave não é alterada no storage.
