---
'@usebridger/core': minor
'@usebridger/transport-baileys': patch
'@usebridger/testing': minor
---

Capability `send.sticker.audio`: a figurinha com `audio` passa a exigi-la, e o transport que não a declara recusa o envio com `UnsupportedError` em vez de mandar a figurinha muda. O `reply.sticker` agora repassa `audioMimetype` e `audioSeconds`, e a figurinha com áudio no Baileys leva as menções. O perfil `whatsapp` do `@usebridger/testing` declara a capability.
