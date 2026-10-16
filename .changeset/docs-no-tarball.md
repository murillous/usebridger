---
'@usebridger/core': patch
'@usebridger/storage-postgres': patch
'@usebridger/storage-sqlite': patch
'@usebridger/testing': patch
'@usebridger/transport-baileys': patch
'@usebridger/transport-web': patch
'create-bridger-plugin': patch
---

A pasta `docs/` de cada pacote passa a entrar no tarball do npm (#91), para a documentação viajar
com a versão instalada. Sem mudança de API.
