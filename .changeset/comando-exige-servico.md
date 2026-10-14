---
'@usebridger/core': minor
---

Comando que exige serviço (ADR 0099): `command({ services: ['sticker'] })` deixa o comando fora do roteador, do `ctx.commands.list()` e do menu nativo enquanto o serviço não está provido, com log `warn` e a entrada em `unregistered` (agora com `services`). O manifesto ganha `optionalDependsOn`, no formato do `dependsOn` (`{ sticker: '^0.1.0' }`): o provedor carrega antes, se existir, não impede a carga do plugin e o recarrega em cascata no `reload`, `disable` e `enable`, então o comando some e volta junto com o provedor. Provedor fora da faixa não impede a carga e gera `warn` no boot, como o `^0.0.z`.
