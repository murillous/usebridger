---
'@usebridger/core': patch
---

Auth da API sem corridas (ADR 0128): o primeiro owner (bootstrap), o e-mail único e a regra do
último owner passam a rodar sob uma trava no storage (`increment` + `update` condicional), então
aceites e cadastros simultâneos não criam dois owners nem e-mails repetidos, e dois owners não
se desativam juntos. Sem mudança na interface do storage.
