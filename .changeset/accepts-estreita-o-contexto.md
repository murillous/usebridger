---
'@usebridger/core': minor
---

`command()` e os `commands` do `definePlugin` inferem o `accepts`: quando toda entrada tem mídia, o `run` recebe `MediaCommandContext`, com `ctx.media` como `Media` e `ctx.accepted` como `AcceptedMessage`, sem `null`. Nova entrada `'args'` no `accepts`, que casa só quando há texto depois do comando: `['sticker', 'quoted:sticker', 'args']` aceita mídia ou um link, e o comando sozinho cai no `onReject` (ADR 0094).
