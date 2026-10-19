# ADR 0080 — Kernel e LumaBot em repositórios separados

**Status:** Aceito (2026-10-10) · Plugins oficiais no kernel:
substituído pelo [ADR 0082](0082-plugins-da-luma-no-lumabot.md)

## Contexto

O monorepo inicial pôs o kernel, os plugins, o `apps/lumabot` e o `legacy/` num monorepo só, para o LumaBot
validar a API como consumidor real. Com o release (D78) e o nome próprio (D79), o kernel virou
uma biblioteca publicada, e o monorepo passou a misturar dois ciclos: o deploy de produção da
Luma, que sai da `main`, e o release dos pacotes, que sai da `develop`. O repositório
`murillous/LumaBot` também concentra as stars e os forks, que são do bot.

Alternativas consideradas: manter o monorepo; renomear o `LumaBot` para o kernel e criar um repo
novo para a Luma (as stars iriam para a biblioteca).

## Decisão

- O kernel, os plugins oficiais, o `bench/` e o `tooling/` vivem em **`murillous/usebridger`**,
  com histórico a partir da criação do monorepo (M0-4.1). A `develop` é a branch de integração
  e a `main`, a padrão do GitHub (release desde o [ADR 0081](0081-release-a-partir-da-main.md)).
- O **`murillous/LumaBot`** fica com o app da Luma (`apps/lumabot`), o `legacy/`, o deploy de
  produção, as stars e os forks. O app passa a depender dos `@usebridger/*` publicados no npm.
- Issues e PRs anteriores à separação continuam no `LumaBot`; as do kernel em aberto são
  transferidas. Mensagens de commit antigas citam `murillous/LumaBot#N`.

## Consequências

- O LumaBot valida a API pelo npm, como qualquer consumidor; mudança no core só chega a ele
  depois de publicada.
- A migração incremental do LumaBot (paridade, virada do deploy e remoção do `legacy/`) segue
  inteira no `LumaBot`.
- O workspace deixa de ter `apps/*` e `legacy/`; o CI do kernel roda em `develop` e `main`.
