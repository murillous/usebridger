---
"@usebridger/transport-baileys": minor
"@usebridger/transport-web": minor
"@usebridger/plugin-dashboard": minor
"@usebridger/plugin-metrics": minor
---

Logs pelo contrato do ADR 0118 (#230): cada linha sai com `event` (`baileys.*`, `web.*`, `dashboard.*`, `metrics.*`, e `transport.handler.failed` nos dois transports), mensagem fixa e os valores em campos. O `plugin-dashboard` deixa de escrever o prefixo `dashboard:` na mensagem (o binding `plugin` já diz de onde vem), e o `plugin-metrics` passa a logar o erro em `err`, com mensagem e stack. A lista dos eventos está em `docs/log-events.md` do core.

No `metrics.prometheus.name-collision`, o campo `name` passa a `metric`. Os pacotes usam `log.event`, que existe a partir do `@usebridger/core` 0.10.0: use o core 0.10.0 ou mais novo (nos quatro pacotes, a dependência já sai como `^0.10.0`).
