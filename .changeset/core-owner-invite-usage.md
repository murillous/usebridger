---
'@usebridger/core': patch
---

`bridger owner-invite`: o texto de uso e a doc explicam por que é seguro rodar com o bot no ar (travas
`users`/`owners` no storage, SQLite em WAL com `busy_timeout`, Postgres com `UPDATE` condicional).
