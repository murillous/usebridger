# create-bridger-plugin

## 0.3.0

### Minor Changes

- 834fec4: O projeto gerado traz um `AGENTS.md` com as convenções do plugin para agentes de código (`requires` mínimo, `teardown` e `ctx.signal`, helpers de formatação, `ctx.unsafe`, `z` de `@usebridger/core/zod`, teste em todos os perfis, versão em sincronia) e onde achar a documentação (os guias da `main`, a branch do release), e um `CLAUDE.md` que o importa para o Claude Code.

## 0.2.1

### Patch Changes

- 4e846ec: README na raiz do pacote, para a página do npm mostrar descrição, instalação, um exemplo e os links da documentação.

## 0.2.0

### Minor Changes

- e190d3e: Release de teste do fluxo `develop` → `main` com Trusted Publishing (ADR 0085), sem mudança de API em relação à 0.1.0.

## 0.1.0

### Minor Changes

- 12e4af5: Primeira versão do `create-bridger-plugin` (ADR 0081): `npm create bridger-plugin <pacote>` cria
  um plugin na forma curta, com teste no `@usebridger/testing` nos quatro perfis de plataforma, README,
  `tsconfig` com `isolatedDeclarations`, build pelo `tsdown` e changesets configurado.

### Patch Changes

- 5c864c2: O projeto se chama Bridger, com os pacotes no escopo `@usebridger/*` e o scaffold `create-bridger-plugin` (ADR 0083). A config de plugin lê variáveis com prefixo `BRIDGER_`, a anotação de campo não editável por override é `x-bridger-override`, plugins seguem o prefixo `bridger-plugin-` e o schema Postgres padrão é `bridger`. O repositório passa a ser `murillous/usebridger`.
- a8482ee: Metadados de publicação no `package.json`: `repository` (com a pasta do pacote), `homepage`, `bugs` e acesso público. As dependências entre pacotes `@usebridger/*` passam a sair como `^<versão>` em vez da versão exata.
