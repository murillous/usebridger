# @usebridger/transport-telegram

## 0.2.0

### Minor Changes

- 255b10a: Álbum no envio e na entrada (#308). O transport declara `send.album` com `limits.album: 10`: o
  álbum vai por `sendMediaGroup`, e documento com foto ou vídeo vira dois envios (legenda e citação
  no primeiro, chave do primeiro). Na entrada, os updates com o mesmo `media_group_id` viram uma
  `message` só, com `attachments`, depois de 500 ms sem novo update do grupo; o `disconnect()`
  descarta o álbum pendente. Novo evento de log `telegram.album.failed`.
- 7a78181: O transport do Telegram passa a declarar `polls`: `reply.poll` envia uma enquete não anônima (`multiple` vira `allows_multiple_answers`) e o `poll_answer` chega como o evento `poll.vote`, com a escolha inteira em índices. Voto de enquete enviada antes do restart é descartado, com log `telegram.poll.vote-unknown`.
- b0dde21: Webhook como opção (#310, ADR 0137): `telegram({ token, webhook: { url, secretToken } })` recebe
  os updates pela rota `POST /transports/telegram/webhook` do HTTP do core (ADR 0072), com o
  `webhookCallback` do grammY conferindo o `X-Telegram-Bot-Api-Secret-Token`. O `connect()` chama o
  `setWebhook` com `allowed_updates`; o `disconnect()` não o apaga. Sem `http` no `createBot`, a
  fábrica lança. Sem `getUpdates`, o 401 vem do `getMe` ou do `setWebhook` e vira `auth-failed`.

### Patch Changes

- Updated dependencies [8064725]
- Updated dependencies [a8d1e79]
  - @usebridger/core@0.11.1

## 0.1.1

### Patch Changes

- Updated dependencies [649f774]
- Updated dependencies [817c473]
- Updated dependencies [38d3cbe]
  - @usebridger/core@0.11.0

## 0.1.0

### Minor Changes

- 7eedbad: Pacote novo: transport do Telegram sobre a Bot API, pelo grammY (ADR 0137). `telegram({ token })`
  recebe por long polling, emite `closed` só na queda terminal (401 → `auth-failed`, 409 →
  `replaced`) e declara texto, mídias, citação, menções, botões com `callback_query`, menu de
  comandos (`setMyCommands`), "digitando", reações, edição, apagamento, download e referência de
  mídia (`file_id`), grupos com admin, remoção e promoção, e tópicos de fórum no `chat.id`. Álbum,
  enquetes e webhook ficam para depois (#308, #309, #310).

### Patch Changes

- a36bc23: Documentação revisada contra o código: páginas e comentários da API sem referências internas de decisão, mais exemplos e as lacunas preenchidas (Telegram, referência de mídia, rotas da API, eventos de log).
- Updated dependencies [9a3a657]
- Updated dependencies [f4316ad]
- Updated dependencies [1d4cb96]
- Updated dependencies [aabf039]
- Updated dependencies [227bd98]
- Updated dependencies [184c8cb]
- Updated dependencies [87041b4]
- Updated dependencies [0b340df]
- Updated dependencies [18c56f3]
- Updated dependencies [cc35cbb]
- Updated dependencies [ede77ef]
- Updated dependencies [ae1e2b9]
- Updated dependencies [1c176d8]
- Updated dependencies [f7f5501]
- Updated dependencies [14c3f0c]
- Updated dependencies [b8b6b6e]
- Updated dependencies [6ab377b]
- Updated dependencies [0889b0c]
- Updated dependencies [a36bc23]
- Updated dependencies [48d7580]
- Updated dependencies [0a4c8cd]
- Updated dependencies [3cc14d5]
- Updated dependencies [abc53c7]
- Updated dependencies [48ceea9]
- Updated dependencies [e0bcb8b]
- Updated dependencies [ab54782]
- Updated dependencies [25b0caa]
- Updated dependencies [b7359b5]
- Updated dependencies [6681792]
- Updated dependencies [925a198]
  - @usebridger/core@0.10.0
