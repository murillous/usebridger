# ADR 0136 — Referência de mídia serializável

**Status:** Aceito (2026-10-28) · Estende o modelo de mensagem do **D7**
([ADR 0007](0007-modelo-de-mensagem-normalizado.md)) e as capabilities do **D8**
([ADR 0008](0008-capabilities-do-transporte.md))

## Contexto

A mídia só baixa pela `Message` em memória: `media.download()` e `media.stream()` são lazy e
cacheados na mensagem. Depois de um restart, ou quando a mensagem sai de cena, a API pública não
tem como baixar de novo uma mídia antiga. No Baileys, o download depende do `WAMessage` bruto, e a
única saída de um plugin é guardá-lo via `ctx.unsafe.raw()`, o que o prende ao WhatsApp
(issue #297). O caso que motivou é um plugin de IA que atende "o que foi dito nesses últimos
áudios": ele precisa alcançar mídias que chegaram antes do pedido e só processá-las quando alguém
pedir.

Alternativas consideradas:

- **Processar na chegada, só no plugin** (transcrever, extrair texto). Resolve sem mexer no core,
  mas processa toda mídia, inclusive a que ninguém vai pedir.
- **Baixar os bytes na chegada e guardar com validade.** Troca custo de API por disco e guarda
  conteúdo de conversa por mais tempo (LGPD).
- **`ctx.unsafe.raw()` e download no plugin.** Funciona no WhatsApp, mas não é portável.
- **`media.ref()` na própria `Media`.** A `Media` nasce no `createMessage`, que o transport chama
  sem dizer o próprio nome: o `UnsupportedError` e o campo `transport` da referência não teriam de
  onde sair.

## Decisão

- **`ctx.media.ref(media)`** devolve um `MediaRef`, JSON puro: `{ transport, mimetype, size,
  fileName?, data }`. `data` é opaco e do transport. É `type`, não `interface`, para caber em
  `JsonValue` e ir ao storage sem cast.
- **`ctx.media.fromRef(ref)`** devolve uma `Media` lazy, com `download()`/`stream()` e o mesmo
  cache, sem baixar nada na chamada. Referência malformada ou de outro transport lança `TypeError`.
- **Capability `media.ref`**, com o método opcional **`Transport.mediaFromRef(data)`**, que devolve
  só o loader (`MediaLoader`: `download` e `stream?`). Os metadados vêm da referência. Sem a
  capability, ou para uma mídia sem referência, `ctx.media` lança `UnsupportedError`.
- **O transport dá o `data` no `MediaSource.ref`.** O `createMedia` o guarda num `WeakMap`, fora
  do objeto: não aparece em spread nem em `JSON.stringify` da mensagem.
- **`MediaExpiredError`** (exportado do core): o download de uma mídia que a plataforma não tem
  mais rejeita com ele. O plugin a trata como perdida.
- **Baileys:** `data` é a chave da mensagem, o tipo do conteúdo, a `mediaKey` em base64,
  `directPath` e `url`, sem miniatura. O download usa a conexão do momento, então o Baileys pede o
  reenvio ao aparelho de quem enviou quando a mídia saiu do CDN. Se o 404/410 persiste, a falha
  vira `MediaExpiredError`. Sem conexão, falha com `baileys: sem conexão`, sem dizer que expirou.
- **`transport-web` não declara** `media.ref`: os arquivos dele vivem só em memória (ADR 0073), e
  nenhuma referência sobreviveria ao restart.
- O `FakeTransport` do kit declara `media.ref`, assim como o perfil `whatsapp`. A referência do
  kit são os próprios bytes, para testar o caminho com `restart()`.

## Consequências

- Um plugin guarda referências na chegada e baixa só o que pedirem, em qualquer transport que
  declare `media.ref`, sem `ctx.unsafe`.
- A referência do Baileys contém a chave que decifra o arquivo. Quem a guarda deve tratá-la como
  segredo, fora de logs e de respostas da API. O core não cifra o `MediaRef`.
- `mediaFromRef` é opcional no `Transport`: adapters existentes continuam válidos. Declarar
  `media.ref` sem o método é recusado no boot, como as outras capabilities com método.
- shortcut: o `MediaRef` não diz o tipo da mensagem (`voice`, `document`); o plugin guarda esse
  dado ao lado se precisar.
