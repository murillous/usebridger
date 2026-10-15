---
'@usebridger/core': minor
'@usebridger/testing': minor
---

`Mention` (`Contact` mais `tag`, o trecho literal da menção em `text`) e o helper `textWithMentionNames`, que troca o `tag` de cada menção por `@nome`. No WhatsApp o texto traz `@859302458` e não o nome; o helper entrega ao plugin de IA um texto legível. O `IncomingMessage` do kit de testes aceita `tag` em `mentions`.
