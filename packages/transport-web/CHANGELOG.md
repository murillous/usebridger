# @usebridger/transport-web

## 0.2.2

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

- dc81875: Pacote novo (ADR 0077): transport para o chatbot dentro de um sistema web próprio. A fábrica
  `web({ auth, tenantClaim?, origins?, media? })` registra as rotas do transport no HTTP do core
  (`GET /chat` em WebSocket, `POST /media`, `GET /media/:id`) e exige `http` no `createBot`. O widget
  se autentica com o JWT do sistema do dono no primeiro frame, validado pelo `jose` (`HS256` com
  segredo ou JWKS), e a conexão fecha no `exp`. O `Contact` sai do `sub` com os claims verificados, e
  o `tenantClaim` vira `chat.tenantId`. O `chat.id` é por conversa escolhida pelo cliente. O que o bot
  envia com o cliente fora espera em memória por até 1 h. Mídia entra por upload com o token e sai por
  URL temporária. Capabilities: texto, imagem, vídeo, áudio, documento, download, `actions`,
  `quoted`, `typing`, edição e remoção. O cliente de referência fica em
  `@usebridger/transport-web/client`.

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
