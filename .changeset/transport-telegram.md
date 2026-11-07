---
'@usebridger/transport-telegram': minor
---

Pacote novo: transport do Telegram sobre a Bot API, pelo grammY (ADR 0137). `telegram({ token })`
recebe por long polling, emite `closed` só na queda terminal (401 → `auth-failed`, 409 →
`replaced`) e declara texto, mídias, citação, menções, botões com `callback_query`, menu de
comandos (`setMyCommands`), "digitando", reações, edição, apagamento, download e referência de
mídia (`file_id`), grupos com admin, remoção e promoção, e tópicos de fórum no `chat.id`. Álbum,
enquetes e webhook ficam para depois (#308, #309, #310).
