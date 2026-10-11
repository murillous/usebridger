# ADR 0085 — Release a partir da `main`, com `develop` como integração

**Status:** Aceito (2026-10-11) · Substitui a branch de release do **D82**
([ADR 0082](0082-release-a-partir-de-develop.md)) · Sobre o **D84**
([ADR 0084](0084-repositorios-separados.md))

## Contexto

O D82 tirou o release da `main` porque, no monorepo, ela alimentava a produção do `legacy/`. Com
o kernel no próprio repositório (D84), a `main` ficou livre e virou a branch padrão do GitHub,
mas nada a atualizava: quem abre o repositório ou instala pelo Git via um commit parado.

Alternativas consideradas: merge manual da `develop` na `main` a cada release; o `release.yml`
avançar a `main` sozinho depois de publicar.

## Decisão

- **A `develop` é a branch de integração:** toda PR de feature, fix ou docs entra nela.
- **A `main` é a branch de release e a padrão do GitHub.** Lançar é abrir uma PR `develop` →
  `main`. O push na `main` roda o `release.yml`, que abre o PR de versão contra a `main`, e o
  merge dele publica e cria as tags, como no D82.
- **Depois de publicar, o `release.yml` abre a PR `main` → `develop`** com o token do App. Ela
  devolve à `develop` as versões, os `CHANGELOG.md`, o `CORE_VERSION` e a remoção dos changesets
  consumidos.
- As PRs entre `develop` e `main` entram por **merge commit**, nunca squash: com squash, as duas
  branches divergem a cada release e o merge seguinte conflita.
- O `ci.yml` roda em push e PR para as duas branches. Gate, Trusted Publishing, App e bootstrap
  com `NPM_TOKEN` seguem o D82 sem mudança.

## Consequências

- A `main` sempre aponta para o último código lançado; a `develop`, para o próximo.
- Lançar passa a ter duas PRs a mais (`develop` → `main` e a de volta), mas a de volta é aberta
  pelo workflow.
- O `.changeset/config.json` mantém `baseBranch: develop`, porque é contra ela que o autor de um
  changeset compara as mudanças.
