# @usebridger/transport-telegram

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
