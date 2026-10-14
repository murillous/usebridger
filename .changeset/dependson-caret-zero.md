---
'@usebridger/core': patch
---

O boot avisa em `warn` quando um `dependsOn` usa `^0.0.z`: pela regra do `^`, a faixa aceita só a versão exata `0.0.z`, e o plugin deixa de carregar no primeiro bump de patch da dependência. A mensagem sugere `0.x` ou `>=0.0.0 <1.0.0`.
