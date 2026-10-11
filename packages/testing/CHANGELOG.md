# @usebridger/testing

## 0.3.0

### Minor Changes

- dcb2470: Matchers `toContainVideo()`, `toContainAudio()` e `toContainDocument({ fileName?, mimetype? })`; `bot.sentMedia(type)` devolve os envios de mídia do tipo com os bytes (`null` para mídia por URL); fixtures `animatedSticker()` (WebP animado 512×512) e `gif()`.

### Patch Changes

- Updated dependencies [3cd9b93]
- Updated dependencies [f5c2517]
- Updated dependencies [8ec8937]
- Updated dependencies [a4268bd]
- Updated dependencies [ac67f62]
- Updated dependencies [92e35c0]
- Updated dependencies [e094a23]
- Updated dependencies [b00d09a]
  - @usebridger/core@0.3.0

## 0.2.1

### Patch Changes

- 4e846ec: README na raiz do pacote, para a página do npm mostrar descrição, instalação, um exemplo e os links da documentação.
- Updated dependencies [4e846ec]
  - @usebridger/core@0.2.1

## 0.2.0

### Minor Changes

- e190d3e: Release de teste do fluxo `develop` → `main` com Trusted Publishing (ADR 0085), sem mudança de API em relação à 0.1.0.

### Patch Changes

- Updated dependencies [e190d3e]
  - @usebridger/core@0.2.0

## 0.1.0

### Minor Changes

- 5eb7203: Botões no kit (ADR 0062): o `FakeTransport` declara a capability `actions` por padrão e registra
  os botões em `SentMessage.actions`, e o `TestBot` ganha `click(sent, label, options?)`, que clica
  num botão pelo rótulo e espera o bot assentar.
- ad2d61a: Entry `@usebridger/testing/bot` (#117): exporta o mesmo kit (`createTestBot`, `FakeTransport`,
  `fixtures`) sem registrar os matchers e sem carregar o Vitest. Serve para subir o bot de teste
  fora de um teste, como no benchmark, onde o Vitest somava ~6 MB de RSS à medida.
- 0e21b32: Fixtures de mídia (#114): `fixtures.image()`, `video()`, `audio()`, `voice()`, `sticker()` e
  `document()` devolvem `{ data, mimetype }` com uma mídia pequena e válida de cada tipo, pronta
  para o `bot.receive()`. Um plugin que decodifica a mídia (sharp, ffmpeg) agora pode ser testado
  sem arquivos próprios.
- 39e7242: O `FakeTransport` segue o contrato de grupos multiplataforma do core (ADR 0059): o
  `updateGroupParticipants` cobra `groups.add`, `groups.remove` ou `groups.promote` conforme a ação,
  e não mais `groups.admin`. O grupo registrado com `setGroup` ou `groups` usa `title` no lugar de
  `subject`.
- 611d90d: Novo pacote: kit de testes para autores de plugin (#113). `createTestBot({ plugins })` sobe um
  bot real sobre o `FakeTransport`, sem rede. `bot.receive({ text, image, quoted... })` entrega uma
  mensagem e resolve depois que o bot terminou de processá-la, e `bot.sent` guarda os envios na
  ordem. Importar o pacote registra os matchers do Vitest `toContainText`, `toContainSticker`,
  `toContainImage` e `toHaveReplied`.
- 2db7d00: O `FakeTransport` implementa `raw()` e ganha `setRaw(source, raw)`, e o `receive()` (também na
  citada descrita) e o `click()` aceitam `raw`, para testar plugin que lê o objeto bruto com
  `ctx.unsafe.raw()` (ADR 0066). Sem `raw`, o `ctx.unsafe.raw()` devolve `undefined`.
- dc81875: O perfil `web` passa a declarar o que o `@usebridger/transport-web` declara (ADR 0077): ganha
  `send.video`, `send.audio`, `quoted`, `message.edit` e `message.delete`. Um teste no transport
  confere os dois. Um teste de plugin no perfil `web` que contava com a resposta sem citação passa a
  vê-la citando a mensagem.
- 1438c41: Perfis de plataforma no kit (ADR 0073): `new FakeTransport({ profile })` e
  `createTestBot({ profile })` com `whatsapp`, `telegram`, `discord` e `web`. Cada perfil declara as
  capabilities, os limites de tamanho e os contatos (`self` e remetente padrão do `receive()` e do
  `click()`) da plataforma: sem telefone no Telegram, no Discord e no web. `PROFILES` e
  `PROFILE_NAMES` permitem rodar o mesmo teste em todos os perfis com `describe.each`. Sem perfil,
  nada muda. Os IDs gerados pelo `receive()` passam a recomeçar em cada `TestBot`, sem contador de
  módulo.
- e557209: `FakeTransport` aceita `limits`, para testar a divisão de texto longo, e registra em `edits` a
  árvore (`formatted`) da edição com texto formatado (ADR 0061).
- 7b8ab13: O `FakeTransport` segue o contrato de capabilities do core (ADR 0070): `sendTyping(chatId, kind)`
  no lugar de `sendPresence`, com as chamadas gravadas em `typing` (`{ chatId, kind }`) no lugar de
  `presences`, e cobra a capability `typing`.
- 55bda98: O `receive()` aceita `attachments` depois da mídia principal, com o tipo novo `IncomingAttachment`
  (os bytes, ou os bytes com `mimetype` e `fileName`), para testar mensagens com vários anexos
  (ADR 0065).

### Patch Changes

- 5c864c2: O projeto se chama Bridger, com os pacotes no escopo `@usebridger/*` e o scaffold `create-bridger-plugin` (ADR 0083). A config de plugin lê variáveis com prefixo `BRIDGER_`, a anotação de campo não editável por override é `x-bridger-override`, plugins seguem o prefixo `bridger-plugin-` e o schema Postgres padrão é `bridger`. O repositório passa a ser `murillous/usebridger`.
- a8482ee: Metadados de publicação no `package.json`: `repository` (com a pasta do pacote), `homepage`, `bugs` e acesso público. As dependências entre pacotes `@usebridger/*` passam a sair como `^<versão>` em vez da versão exata.
- Updated dependencies [b7eb3a7]
- Updated dependencies [70220de]
- Updated dependencies [5eb7203]
- Updated dependencies [1d16c73]
- Updated dependencies [852e5f3]
- Updated dependencies [75de529]
- Updated dependencies [e8353c5]
- Updated dependencies [80a15c2]
- Updated dependencies [7b8ab13]
- Updated dependencies [a57530d]
- Updated dependencies [d0654e8]
- Updated dependencies [ec3cdc7]
- Updated dependencies [2bc4478]
- Updated dependencies [9b513b5]
- Updated dependencies [aed50f6]
- Updated dependencies [446b644]
- Updated dependencies [ae2e207]
- Updated dependencies [4b1919a]
- Updated dependencies [88a9c22]
- Updated dependencies [fe9f458]
- Updated dependencies [9e55135]
- Updated dependencies [fdee994]
- Updated dependencies [994259f]
- Updated dependencies [304d0ab]
- Updated dependencies [4ec2ad2]
- Updated dependencies [98cbf9c]
- Updated dependencies [b2acde9]
- Updated dependencies [53baf51]
- Updated dependencies [95a58e7]
- Updated dependencies [285dff9]
- Updated dependencies [3cfe33c]
- Updated dependencies [2fca36a]
- Updated dependencies [ac48966]
- Updated dependencies [39e7242]
- Updated dependencies [54ecf98]
- Updated dependencies [38de373]
- Updated dependencies [166a1fe]
- Updated dependencies [5b45d43]
- Updated dependencies [b79e308]
- Updated dependencies [d6fc723]
- Updated dependencies [b8d950d]
- Updated dependencies [2db7d00]
- Updated dependencies [5ed0705]
- Updated dependencies [ad23521]
- Updated dependencies [5b4dbbe]
- Updated dependencies [46718de]
- Updated dependencies [76e85c0]
- Updated dependencies [4300338]
- Updated dependencies [70489eb]
- Updated dependencies [5934191]
- Updated dependencies [2e58666]
- Updated dependencies [7c8ca66]
- Updated dependencies [bfafe25]
- Updated dependencies [7b76631]
- Updated dependencies [7602730]
- Updated dependencies [02a2650]
- Updated dependencies [96b55e1]
- Updated dependencies [6cbaffe]
- Updated dependencies [431bed1]
- Updated dependencies [05b9d9c]
- Updated dependencies [1a9a88f]
- Updated dependencies [74b61e1]
- Updated dependencies [9536946]
- Updated dependencies [c235aea]
- Updated dependencies [8e847ab]
- Updated dependencies [e557209]
- Updated dependencies [a821a90]
- Updated dependencies [106f17d]
- Updated dependencies [6a17ed4]
- Updated dependencies [d991415]
- Updated dependencies [929c946]
- Updated dependencies [e54996b]
- Updated dependencies [55bda98]
- Updated dependencies [fdd868d]
- Updated dependencies [91fec63]
- Updated dependencies [5c864c2]
- Updated dependencies [a8482ee]
  - @usebridger/core@0.1.0
