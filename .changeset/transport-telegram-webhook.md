---
'@usebridger/transport-telegram': minor
---

Webhook como opção (#310, ADR 0137): `telegram({ token, webhook: { url, secretToken } })` recebe
os updates pela rota `POST /transports/telegram/webhook` do HTTP do core (ADR 0072), com o
`webhookCallback` do grammY conferindo o `X-Telegram-Bot-Api-Secret-Token`. O `connect()` chama o
`setWebhook` com `allowed_updates`; o `disconnect()` não o apaga. Sem `http` no `createBot`, a
fábrica lança. Sem `getUpdates`, o 401 vem do `getMe` ou do `setWebhook` e vira `auth-failed`.
