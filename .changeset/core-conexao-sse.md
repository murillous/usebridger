---
'@usebridger/core': minor
---

Conexão e tempo real pela API (ADR 0129, M7-5): `GET /api/connection` (estado, transport, conta
conectada), `POST /api/connection/pairing-code` e `POST /api/connection/logout`, e `GET /api/events`
em SSE com `connection.status`, `connection.qr`, `connection.pairing-code`, `log` e
`plugin.status`, filtrados por permissão e por `?types=`, com retomada pelo `Last-Event-ID`. O
`Transport` ganha os métodos opcionais `requestPairingCode(phone)` e `logout()`, e a
`ApiOperation`, `stream: true` para descrever resposta SSE na spec.
