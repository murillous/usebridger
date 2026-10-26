---
'@usebridger/core': patch
---

`bridger owner-invite`: o texto de uso e a doc explicam por que é seguro rodar com o bot no ar
(operações atômicas, SQLite em WAL com `busy_timeout`, Postgres), agora coberto por testes nos dois
storages.
