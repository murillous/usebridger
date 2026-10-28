---
'@usebridger/core': minor
---

Quebra (M7-4, ADR 0128): sem `api.auth`, o bot só aceita `BotConfig.http` cujo `hostname` é
loopback (`127.0.0.0/8`, `::1`, `localhost`). Hostname ausente (todas as interfaces), `0.0.0.0`, `::`
ou outro lança `BotConfigError` na criação do bot. Para expor a API, configure `api.auth`; para
desenvolvimento local, use `createHttp({ port, hostname: '127.0.0.1' })`.
