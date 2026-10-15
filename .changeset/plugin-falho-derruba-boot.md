---
'@usebridger/core': minor
'@usebridger/testing': minor
'create-bridger-plugin': patch
---

Plugin incompatível ou com `setup` falho derruba o boot (ADR 0102, #117). **Breaking:**
`bot.start()` (e `createTestBot`) rejeita com `PluginBootError` quando um plugin não carrega por
`engine`, `transport`, `capabilities`, `dependency-missing`, `dependency-version`,
`dependency-skipped` ou `setup-failed` (inclusive config inválida e timeout), em vez de subir sem
ele. O erro traz `failures` (todas as falhas, na ordem de carga), `plugin`, `version` e `reason` da
primeira, e `cause` em `setup-failed`; a mensagem lista `nome@versão: motivo` de cada uma. As
incompatibilidades são checadas antes de qualquer `setup`; com `setup` falho, quem já subiu
desce, e o transport não conecta. A falha de `setup` no boot não emite mais `plugin.error`.

Continua sem derrubar: plugin em `disabledPlugins`, `requires`/`services` por comando, e
`reload`/`disable`/`enable` em runtime. Para subir sem um plugin de propósito (ex.: um que só
existe em outro transport), liste-o em `disabledPlugins`, junto com quem depende dele por
`dependsOn`. O conflito de nome de comando, papel ou serviço continua saindo com o próprio erro.
