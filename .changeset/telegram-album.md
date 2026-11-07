---
'@usebridger/transport-telegram': minor
---

Álbum no envio e na entrada (#308). O transport declara `send.album` com `limits.album: 10`: o
álbum vai por `sendMediaGroup`, e documento com foto ou vídeo vira dois envios (legenda e citação
no primeiro, chave do primeiro). Na entrada, os updates com o mesmo `media_group_id` viram uma
`message` só, com `attachments`, depois de 500 ms sem novo update do grupo; o `disconnect()`
descarta o álbum pendente. Novo evento de log `telegram.album.failed`.
