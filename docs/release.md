# Release dos pacotes

Como os pacotes publicáveis (`packages/*` sem `private`) saem para o npm. O porquê
está nos ADRs [0082](adr/0082-release-a-partir-de-develop.md) e
[0085](adr/0085-release-a-partir-da-main.md); o changeset de cada PR, no
[`.changeset/README.md`](../.changeset/README.md).

## Fluxo

1. PR com changeset entra na `develop`, a branch de integração.
2. Para lançar, abra uma PR `develop` → `main` e faça o merge com **merge commit**, nunca squash:
   com squash, as duas branches divergem a cada release e o merge seguinte conflita.
3. O push na `main` roda o [`release.yml`](../.github/workflows/release.yml). Com changesets
   pendentes, ele abre ou atualiza o PR **`chore(release): versão dos pacotes`**, gerado pelo
   `pnpm version-packages`: versões novas, `CHANGELOG.md` de cada pacote e o `CORE_VERSION` do
   core sincronizado.
4. Revise as versões e os changelogs e faça o merge do PR de versão. Ele roda o `ci.yml` como
   qualquer PR.
5. O push desse merge, já sem changesets, publica com `pnpm release` (`pnpm build && changeset
   publish`) e cria as tags `<pacote>@<versão>` (ex.: `@usebridger/core@0.1.0`). Pacote cuja versão
   já está no npm é pulado.
6. Depois de publicar, o workflow abre a PR **`chore(release): leva a main de volta para a
   develop`**. Faça o merge dela, também com merge commit: ela devolve à `develop` as versões,
   os changelogs, o `CORE_VERSION` e a remoção dos changesets consumidos.

Antes da action, o job roda `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` e
`pnpm check:packages` no mesmo commit: nada sai sem o gate verde. Execuções seguidas esperam a
vez, sem cancelar a anterior.

O `workflow_dispatch` roda o mesmo fluxo à mão, só a partir da `main`.

## Segredos e configuração

| Onde | Nome | Para quê |
| --- | --- | --- |
| Variável do repositório | `RELEASE_APP_ID` | ID do GitHub App que abre o PR de versão |
| Secret do repositório | `RELEASE_APP_PRIVATE_KEY` | Chave privada (`.pem`) do App |
| Secret do repositório | `NPM_TOKEN` | **Só no bootstrap** de um pacote novo, com bypass de 2FA; apague depois |
| Settings → Actions → General | "Allow GitHub Actions to create and approve pull requests" | Exigido pela `changesets/action` |

### GitHub App

Um PR aberto com o `GITHUB_TOKEN` não dispara outros workflows, e o PR de versão ficaria sem os
checks do `ci.yml`. Por isso o PR é aberto com o token de um App:

1. Crie um App na conta `murillous` (Settings → Developer settings → GitHub Apps), sem webhook,
   com as permissões de repositório **Contents: Read and write** e **Pull requests: Read and
   write**.
2. Instale o App só no repositório `usebridger`.
3. Gere uma chave privada e salve o ID e a chave como `RELEASE_APP_ID` e
   `RELEASE_APP_PRIVATE_KEY`.

### npm: Trusted Publishing

Em regime, o workflow publica sem token: o pnpm troca o token OIDC do GitHub Actions
(`id-token: write`) por uma credencial de curta duração do npm e publica com provenance. Para
cada pacote, em npmjs.com → pacote → Settings → **Trusted Publisher**: GitHub Actions, dono
`murillous`, repositório `usebridger`, workflow `release.yml`.

O Trusted Publishing não cria pacote: só publica num pacote que já existe.

### Primeiro publish de um pacote (bootstrap)

Vale para a primeira publicação do repositório e para cada pacote novo depois dela.

1. No npm, crie um token **granular** com permissão de publish só nos pacotes do release
   (`@usebridger/*` e `create-bridger-plugin`), validade curta e **Bypass two-factor
   authentication (2FA)** marcado. Salve-o como o secret `NPM_TOKEN`.
2. Faça o merge do PR de versão. O workflow escreve o token no `~/.npmrc` do runner e publica.
3. Configure o Trusted Publisher em cada pacote recém-criado (seção acima).
4. Apague o secret `NPM_TOKEN` e revogue o token no npm.

Sem o secret, o passo do token não faz nada e o publish segue pelo OIDC.

O bypass vem desmarcado por padrão. Sem ele, numa conta com 2FA, o publish falha com
`ERR_PNPM_OTP_NON_INTERACTIVE`: o npm pede o código e o runner não tem como responder. Para
corrigir, crie outro token com o bypass, troque o secret e rode de novo só o job que falhou
(`gh run rerun <id> --failed`), sem novo merge.

O GitHub anunciou que, a partir de janeiro de 2027, tokens com bypass de 2FA deixam de publicar
direto: só preparam um publish, que um mantenedor aprova com 2FA
([changelog](https://github.blog/changelog/2026-07-31-restricting-npm-bypass-2fa-granular-access-tokens)).
Daí em diante, o bootstrap de um pacote novo pede essa aprovação manual. Em regime, nada muda,
porque o Trusted Publishing não usa token.

## Ensaio local

Para conferir o que sairia, sem publicar:

```sh
pnpm version-packages          # numa cópia descartável (git worktree): consome os changesets
pnpm build
pnpm check:packages            # publint, metadados e README de cada pacote publicável
pnpm -r --filter "./packages/*" publish --dry-run --no-git-checks
```

Descarte a cópia depois: o PR de versão real sai do workflow.

## Reverter um publish ruim

Nunca use `npm unpublish`: quebra quem já instalou e bloqueia o número da versão.

1. Marque a versão como depreciada, apontando a saída:
   `npm deprecate @usebridger/<pacote>@<versão> "Quebrada: use <versão-corrigida>"`.
2. Se a versão ruim virou a `latest`, volte a tag para a anterior:
   `npm dist-tag add @usebridger/<pacote>@<versão-boa> latest`.
3. Corrija na `develop` com um changeset `patch` e leve para a `main`; o próximo release publica
   a versão corrigida.
