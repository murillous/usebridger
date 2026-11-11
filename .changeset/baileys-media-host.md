---
'@usebridger/transport-baileys': patch
---

Download de mídia usa o host de mídia do socket (`media_conn`), com `mmg.whatsapp.net` de reserva, em vez do host do `url` da mensagem. O WhatsApp do PC manda `a.whatsapp.net`, que não resolve, e o download falhava com `ENOTFOUND`, inclusive pela referência serializável (#334).
