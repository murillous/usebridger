# Bridger

Kernel de bot de mensageria extensível por plugins — em construção.
Plano, decisões e marcos: [`BRIDGER_PLAN.md`](BRIDGER_PLAN.md).
O porquê de cada decisão (`DNN` no plano, `ADR 00NN`) está nos ADRs em [`docs/adr/`](docs/adr/README.md).
Para escrever um plugin, comece pelos [guias do autor](docs/guias/README.md).

O LumaBot, app de referência que usa o Bridger, vive em
[`murillous/LumaBot`](https://github.com/murillous/LumaBot).

Quer contribuir? Veja o [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Desenvolvimento

Monorepo pnpm (`packages/*`, `bench/` e `site/`). A versão do
pnpm vem de `packageManager` no `package.json` — com `corepack enable`, basta rodar
`pnpm install` na raiz.

Requer Node 24+ (`engines` na raiz; `.nvmrc` para `nvm use`/`fnm use`).

### Comandos (na raiz)

| Comando | O que faz |
| --- | --- |
| `pnpm lint` / `pnpm lint:fix` | Biome: lint + formatação + organização de imports |
| `pnpm typecheck` | `tsc -b` em todos os pacotes (project references) |
| `pnpm test` | Vitest em todos os pacotes |
| `pnpm build` | `tsdown` em cada pacote (ESM + `.d.ts` em `dist/`) |
| `pnpm run docs` | Site de documentação ([`site/`](site)): sincroniza o Markdown do repo, gera a referência da API com o TypeDoc, o `llms.txt` e o `.md` de cada página (`/guias/comandos/` → `/guias/comandos.md`), em `site/dist/`. O `run` é obrigatório: no pnpm 12, `pnpm docs` é um comando nativo que abre a página de um pacote do registry |
| `pnpm bench` | Build e benchmark das metas de performance ([`bench/`](bench/docs/README.md)) |
| `pnpm changeset` | Registra a mudança de um pacote publicável |
| `pnpm version-packages` | Consome os changesets (versões e changelogs) e sincroniza o `CORE_VERSION` |
| `pnpm check:packages` | Confere os pacotes publicáveis depois do build: publint no tarball, metadados do publish e `README.md` na raiz |
| `pnpm release` | Build e `changeset publish`; quem roda é o workflow de release ([`docs/release.md`](docs/release.md)) |

### Novo pacote

```
packages/<nome>/
  package.json
  tsconfig.json
  README.md
  src/index.ts
  docs/README.md
```

O `README.md` da raiz é a página do pacote no npm, que só lê esse arquivo: descrição, instalação,
um exemplo curto e links absolutos para o `docs/` no GitHub. O COMO completo fica em `docs/`, que
não vai para o tarball.

`package.json`:

```json
{
  "name": "@usebridger/<nome>",
  "version": "0.0.0",
  "license": "Apache-2.0",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/murillous/usebridger.git",
    "directory": "packages/<nome>"
  },
  "type": "module",
  "imports": { "#*": "./src/*" },
  "exports": {
    ".": {
      "@usebridger/source": "./src/index.ts",
      "types": "./dist/index.d.mts",
      "default": "./dist/index.mjs"
    }
  },
  "files": ["dist"],
  "scripts": { "build": "tsdown" },
  "publishConfig": { "access": "public" }
}
```

`tsconfig.json` (em `references`, os pacotes `@usebridger/*` de que este depende):

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": ".tsbuild" },
  "include": ["src"],
  "references": [{ "path": "../core" }]
}
```

E adicione o pacote em `references` no `tsconfig.json` da raiz. Testes (`*.test.ts`) ficam
ao lado do código em `src/`; o Vitest descobre o pacote sozinho.

### TypeScript

`tsconfig.base.json`: strict, ESM, `nodenext`. Em dev o Node executa o `.ts` direto, então:

- só vale sintaxe apagável (`erasableSyntaxOnly` — sem `enum`, `namespace`, parameter properties);
- imports levam a extensão `.ts` (`import { x } from './x.ts'`);
- a API exportada tem tipos explícitos (`isolatedDeclarations`), o que permite ao tsdown gerar
  os `.d.ts` sem rodar o compilador.

O `tsc` só checa tipos; o JS publicado sai do tsdown, com as dependências fora do bundle.

### Imports

- **Entre pacotes**: pelo nome (`import { … } from '@usebridger/core'`), com a dependência
  `"@usebridger/core": "workspace:^"` (no publish vira `^<versão>`) — sem `paths` no tsconfig. A condição `@usebridger/source`
  nos `exports` aponta para o fonte: TypeScript (`customConditions`) e Vitest já a usam, e
  para rodar sem build use `node --conditions=@usebridger/source src/main.ts`. Fora dela, o
  pacote resolve para `dist/`.
- **Dentro do pacote**: relativo só para a mesma pasta ou abaixo (`./sub/x.ts`). Para subir
  de pasta, use o alias do próprio pacote (`import { env } from '#config/env.ts'`, via
  `imports` no `package.json`) — o Biome barra `../`.

### Regras do Biome

Além do preset recomendado, viram erro: `export default` (exceto em `*.config.ts`), import
relativo ascendente, `process.env` fora da camada de config (`src/config.ts` ou `src/config/`)
e `catch` sem nenhuma instrução — inclusive só com comentário (plugin em
[`tooling/biome/`](tooling/biome/no-swallowed-catch.grit)).

### Changesets

PR que muda um pacote publicável leva um changeset (`pnpm changeset`) — ver
[`.changeset/README.md`](.changeset/README.md). Os changesets se acumulam na `develop`; lançar é
levá-los para a `main`, onde o workflow de release abre o PR de versão e publica no npm depois
do merge dele: fluxo, segredos e como reverter em [`docs/release.md`](docs/release.md).

### Site de documentação

`pnpm run docs` builda o site em `site/dist/`; `pnpm --filter @usebridger/site dev` sobe o
servidor de desenvolvimento. Os dois sincronizam o Markdown antes. Onde cada página vive:

- `docs/` da raiz e `packages/*/docs/`: Markdown do repositório, sincronizado para o site no
  build. Edite aqui, nunca a cópia.
- `site/src/content/docs/`: páginas escritas à mão (home, getting started).
- `examples/`: código dos exemplos do getting started, pacotes privados verificados no
  typecheck e no teste.

A referência da API é gerada do fonte pelo TypeDoc (rode `pnpm build` antes). Cada subpath dos
`exports` com a condição `@usebridger/source` vira um módulo com o nome do import
(`@usebridger/core/adapter`); internos do core não aparecem, e o `create-bridger-plugin` fica de
fora (binário, sem API importável). O texto vem do TSDoc no código.

**Novo pacote ou novo export:** acrescente o arquivo de fonte em `entryPoints`, no
`starlightTypeDoc` de `site/astro.config.mjs`. O plugin `site/module-names.js` compara a lista com
os `exports` dos `package.json`: export sem entrada ou entrada sem export vira warning, e o
`treatWarningsAsErrors` falha o build até as duas baterem.

**Por que TypeScript 6 no site:** o repositório usa o TypeScript 7, cuja API de compilador ainda é
experimental; o TypeDoc 0.28 depende da API do 6 e aceita no máximo o 6.0 (peer dependency). Por
isso o `site/` fixa `typescript@6.0.3` só para ele; a checagem de tipos e o build dos pacotes
seguem no 7. Quando o TypeDoc suportar o 7, basta remover a dependência.

Decisões em [ADR 0099](docs/adr/0099-site-de-documentacao.md).

### CI

Todo push e PR para `develop` ou `main` roda o [`ci.yml`](.github/workflows/ci.yml), com os jobs
`Lint`, `Typecheck`, `Testes` e `Build` (os mesmos comandos da tabela acima) e o store do pnpm
em cache. O job `Scaffold` gera um plugin com o `create-bridger-plugin` e confere que ele
instala, testa e builda ([e2e](packages/create-plugin/docs/README.md#e2e)). O job `Testes` sobe
um Postgres em container para o `@usebridger/storage-postgres`. O job `Benchmark` mede as metas
de performance e falha com piora > 10% sobre o baseline do commit-base, medido no mesmo runner
e intercalado com o commit testado ([ADR 0050](docs/adr/0050-baseline-do-benchmark.md),
[ADR 0085](docs/adr/0085-benchmark-intercalado.md)). O job `Docs` builda o site e falha com link quebrado ou warning do TypeDoc; o
[`docs.yml`](.github/workflows/docs.yml) o publica no GitHub Pages a cada push na `main`. O job `Pacotes` builda e roda o
`pnpm check:packages`, para um pacote que não publicaria quebrar no PR e não no release.

O setup comum (Node do `.nvmrc`, pnpm do `packageManager`, `pnpm install --frozen-lockfile`)
fica em [`.github/actions/setup`](.github/actions/setup/action.yml).

O push na `main` também roda o [`release.yml`](.github/workflows/release.yml), que abre o PR de
versão ou publica os pacotes ([`docs/release.md`](docs/release.md),
[ADR 0081](docs/adr/0081-release-a-partir-da-main.md)).

## Licença

[Apache-2.0](LICENSE) ([ADR 0025](docs/adr/0025-licenca-apache-2.md)).
