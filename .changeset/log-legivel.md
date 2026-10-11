---
'@usebridger/core': minor
'@usebridger/transport-baileys': minor
---

Log legível no terminal: `createLogger({ format: 'pretty' })` e `logFormat: 'pretty'` no bot escrevem hora, nível, `[plugin]`, a mensagem e os campos em `chave=valor`, com o `err` recuado nas linhas seguintes e cor no terminal. O padrão segue JSON. No `@usebridger/transport-baileys`, a opção `logLevel` (padrão `'warn'`) põe um piso nas linhas do próprio Baileys: a sincronização e o protocolo, em inglês, saem do `info`. O `console` do libsignal (`Closing session: SessionEntry {...}`) passa a ir para o mesmo logger, em `debug`, sem os objetos de sessão (ADR 0091).
