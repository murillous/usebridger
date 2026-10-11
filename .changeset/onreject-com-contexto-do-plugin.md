---
'@usebridger/core': minor
---

No comando declarado no manifesto (`commands`), o `onReject` recebe o contexto do plugin no 3º argumento, como o `run` no 2º: a recusa pode usar `plugin.plugin.messages`, que a config sobrescreve. O `CommandDefinition` solto não muda.
