# @usebridger/transport-baileys

## 0.4.0

### Minor Changes

- 4bcc823: Menções com nome e tag (#109): cada item de `mentions` traz `tag` (o `@usuário` literal do texto, calculado pela mesma função que escreve a menção de saída) e `name` quando o contato já foi visto. O cache de nomes trata LID e telefone da mesma pessoa como apelidos e passa a aprender também com `contacts.upsert`, `contacts.update` e `messaging-history.set` (prioridade `notify`, `verifiedName`, depois o nome da agenda), emitindo `contact.updated` para nomes novos. Contato nunca visto segue com `name: null`; o cache é em memória.
- 09bd4f8: Os nomes de contatos que dão nome às menções, reações, votos e apagamentos agora persistem no auth state da sessão e sobrevivem ao restart. A leitura é lazy (só quando a memória não sabe o nome, com cache negativo) e a escrita é em lote com debounce, então o storage fica fora do caminho de cada mensagem. O logout apaga os nomes junto com as credenciais.

### Patch Changes

- Updated dependencies [513051d]
  - @usebridger/core@0.5.0

## 0.3.1

### Patch Changes

- Updated dependencies [c6d3256]
- Updated dependencies [193f283]
- Updated dependencies [2ca908b]
- Updated dependencies [81535a0]
- Updated dependencies [f637749]
- Updated dependencies [be082f9]
- Updated dependencies [0cc4cab]
- Updated dependencies [5b2d55e]
- Updated dependencies [175cb4a]
- Updated dependencies [5c68c87]
  - @usebridger/core@0.4.0

## 0.3.0

### Minor Changes

- a4268bd: Log legível no terminal: `createLogger({ format: 'pretty' })` e `logFormat: 'pretty'` no bot escrevem hora, nível, `[plugin]`, a mensagem e os campos em `chave=valor`, com o `err` recuado nas linhas seguintes e cor no terminal. O padrão segue JSON. No `@usebridger/transport-baileys`, a opção `logLevel` (padrão `'warn'`) põe um piso nas linhas do próprio Baileys: a sincronização e o protocolo, em inglês, saem do `info`. O `console` do libsignal (`Closing session: SessionEntry {...}`) passa a ir para o mesmo logger, em `debug`, sem os objetos de sessão (ADR 0091).

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

- 96dc32c: Novo pacote: transport do WhatsApp sobre o Baileys (#103). `baileys({ pairing, version })`
  devolve a fábrica para `createBot({ transport })`. Conecta, pareia por QR (`connection.qr`) ou por
  código (`pairing: { phone }`, `connection.pairing-code`), guarda as credenciais no auth state do
  storage do bot e informa cada queda com o motivo normalizado; a reconexão fica com o bot. Envio e
  recebimento de mensagens ainda não: as ações lançam `UnsupportedError`.
- 929c946: A localização traz o endereço em `location.address` quando o WhatsApp o informa (ADR 0069). O
  `name` segue igual, com o endereço no lugar do nome que falta.
- 1245f6d: O transport passa a enviar e agir (#105, #106): declara as 17 capabilities do plano §6.10 e
  implementa `send` (texto, imagem, vídeo, áudio, voz, sticker, documento e enquete, com citação e
  menções), `react`, `edit`, `delete`, `sendPresence`, `getGroupMetadata` e
  `updateGroupParticipants`. Citar uma mensagem recebida manda ao Baileys o proto original. Os
  metadados de grupo ficam em cache por grupo, invalidado pelos eventos de grupo do Baileys, pela
  alteração de participantes e a cada conexão, e o envio em grupo reaproveita o cache. Recusa de
  qualquer participante no `updateGroupParticipants` lança com o status de cada um.
- 581decd: O transport passa a emitir os eventos do barramento além de `message` (#108): `reaction`,
  `message.edited` (com `isEdited: true`), `message.deleted`, `group.participants`, `group.joined`,
  `group.left`, `group.updated` e `contact.updated`. Todos seguem a fila das mensagens, na ordem de
  chegada. O `contact.updated` sai na primeira mensagem de cada contato e depois só quando o nome ou
  o telefone muda, antes da `message`. Reação, edição, apagamento e grupo completam o nome do
  contato com o último `pushName` visto.
- 39e7242: Segue o contrato de grupos multiplataforma do core (ADR 0059). Os eventos `group.*` trazem o grupo
  em `chat` no lugar de `groupId`, e o `group.updated` e o `getGroupMetadata` trazem o nome em
  `title` (o `subject` do WhatsApp). O transport declara `groups.add`, `groups.remove` e
  `groups.promote` no lugar de `groups.admin`. O comportamento no WhatsApp não muda.
- 85f2ccf: O transport passa a receber mensagens (#104): cada mensagem nova do `messages.upsert` vira o
  evento `message` com a `Message` normalizada do core. Os envelopes ephemeral, viewOnce e
  documentWithCaption são desembrulhados (`isViewOnce` marcado), a citada vem como `Message` e
  `sender`, `mentions` e o autor da citada trazem `phone` resolvido também quando o id é um LID,
  para os `owners` e o `group-admin` funcionarem. A mídia baixa sob demanda. Histórico (`append`),
  status e mensagens de controle (edição, reação, apagamento) não viram `message`.
- 2db7d00: `raw()` devolve o `WAMessage` de onde a mensagem saiu, para o `ctx.unsafe.raw()` (ADR 0066). A
  citada devolve o proto montado do `contextInfo`, sem `pushName` nem horário.
- e557209: Texto formatado neutro do core na marcação do WhatsApp (ADR 0061): `*negrito*`, `_itálico_`,
  `` `código` ``, `rótulo (url)` no link e `@número` na menção, com o JID na lista de menções.
  Vale para o texto, para a legenda e para o `edit`.
- 7b8ab13: Segue o contrato de capabilities do core (ADR 0070). O transport declara `typing` no lugar de
  `presence` e implementa `sendTyping`: `text` envia a presença `composing`, e `voice`, a `recording`.
  A enquete com `multiple: true` sai com `selectableCount` 0 (quantas quiser); sem ela, 1. O status
  online global fica no socket nativo.
- 91fec63: Emite `poll.vote` (ADR 0071). O transport guarda em memória as enquetes que envia e recebe (até
  1000, esquecidas no `disconnect()`) e decifra o voto, que o Baileys 7 entrega cifrado, tentando o
  telefone e o LID de quem criou e de quem votou. Voto de enquete que o transport não viu é
  descartado com log em debug.

### Patch Changes

- 5c864c2: O projeto se chama Bridger, com os pacotes no escopo `@usebridger/*` e o scaffold `create-bridger-plugin` (ADR 0083). A config de plugin lê variáveis com prefixo `BRIDGER_`, a anotação de campo não editável por override é `x-bridger-override`, plugins seguem o prefixo `bridger-plugin-` e o schema Postgres padrão é `bridger`. O repositório passa a ser `murillous/usebridger`.
- a8482ee: Metadados de publicação no `package.json`: `repository` (com a pasta do pacote), `homepage`, `bugs` e acesso público. As dependências entre pacotes `@usebridger/*` passam a sair como `^<versão>` em vez da versão exata.
- 55bda98: O Baileys não declara `send.album`: no WhatsApp, a fila envia o álbum item a item. O `toContent`
  lança `UnsupportedError` para o `album`, que só chega se alguém pular a checagem (ADR 0065).
- 3f231d7: As chaves do auth state passam por um cache em memória por tentativa de conexão
  (`makeCacheableSignalKeyStore` do Baileys): leituras repetidas não vão mais ao storage. As
  gravações seguem indo ao storage na hora.
- fdee994: O Baileys declara a capability `pairing`: credencial rejeitada (403, 411) continua limpando a
  sessão e pareando de novo, em vez de parar o bot como num transport por token (ADR 0068).
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
