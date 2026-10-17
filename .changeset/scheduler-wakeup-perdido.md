---
'@usebridger/core': patch
---

Scheduler: a série recorrente não para mais de disparar quando a próxima ocorrência é gravada enquanto o loop termina. O pedido de nova volta feito nessa janela se perdia e a série ficava com `fireAt` no passado, sem timer armado, até outro `at`/`every`/`on` acordar o loop.
