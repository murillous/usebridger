---
'@usebridger/core': minor
'@usebridger/transport-baileys': minor
'@usebridger/testing': minor
---

Referência de mídia serializável (ADR 0136, #297): `ctx.media.ref(media)` devolve um `MediaRef`
JSON para guardar no storage, e `ctx.media.fromRef(ref)` devolve uma `Media` lazy que baixa
depois, mesmo após um restart. Capability nova `media.ref`, com o método opcional
`Transport.mediaFromRef(data)` (tipo `MediaLoader` no `@usebridger/core/adapter`) e o
`MediaSource.ref` para o transport dar o dado da referência. A mídia que a plataforma não tem
mais rejeita o download com `MediaExpiredError`.

O Baileys declara `media.ref`: a referência leva a chave da mensagem, a `mediaKey`, o
`directPath` e a `url`, e o download pede o reenvio ao celular da conta do bot quando a mídia saiu do CDN. A
`mediaKey` decifra o arquivo: trate a referência como segredo. O `FakeTransport` e o perfil
`whatsapp` do kit de testes também declaram `media.ref`.
