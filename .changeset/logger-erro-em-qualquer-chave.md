---
"@usebridger/core": patch
"@usebridger/plugin-dashboard": patch
---

Logger: um `Error` em qualquer chave dos campos (`{ error }`) sai serializado como o `err`, com `type`, `message`, `stack` e `cause`, em vez de `{}`; no formato `pretty`, vai para as linhas seguintes com o nome do campo. O `plugin-dashboard` passa a logar os erros em `{ err }`.
