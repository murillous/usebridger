# CLAUDE.md

Monorepo do **Bridger**, kernel de bot de mensageria extraído do LumaBot. Plano e roadmap:
`BRIDGER_PLAN.md`; o porquê de cada decisão: `docs/adr/`. Siga as decisões
registradas; para mudar uma, proponha um ADR novo que a substitua.

## Onde você está

- **Kernel** (`packages/*`, `plugins/*`): pnpm workspace, TypeScript, Node 24+. Setup,
  comandos, layout de pacote, imports e regras do Biome estão no `README.md` — leia antes de
  criar ou mexer num pacote.
- O LumaBot (app de referência e `legacy/`) vive em `murillous/LumaBot` e usa os pacotes do npm
  ([ADR 0084](docs/adr/0084-repositorios-separados.md)).

## Git

Branch a partir de `develop` e PR com `--base develop`, a branch padrão e a do release
([ADR 0082](docs/adr/0082-release-a-partir-de-develop.md)). Commits em Conventional Commits, descrição em PT-BR, com o ID do roadmap:
`feat(core): roteador de comandos (M1-2.1)`. `Closes #N` no commit ou PR de cada issue.

## Convenções

O Biome barra default export, `../`, `process.env` fora da config e `catch` vazio. Além dele:

- Comentários em PT-BR explicando o **porquê**; o óbvio fica sem comentário.
- Erro sempre tem destino: tratado, relançado ou registrado com fallback explícito.
- A menor solução que resolve: abstração e configuração só quando a tarefa atual exige.
- Plugins conversam com o core pela API pública (`@usebridger/*`). Se faltar algo, a lacuna é
  do core — resolva lá ([ADR 0029](docs/adr/0029-open-core-repo-privado.md)).

## Definição de pronto

Uma tarefa só está pronta com **todos** os itens:

1. `pnpm lint`, `pnpm typecheck`, `pnpm test` e `pnpm build` verdes.
2. Testes novos para o comportamento novo. Testes existentes ficam intactos — se um parece
   errado, pergunte ao dono do repositório antes de alterar ou apagar.
3. Docs do COMO em `docs/` (do pacote ou da raiz), ADR em `docs/adr/` quando houve decisão
   arquitetural, e changeset (`pnpm changeset`) quando mudou um pacote publicável — o
   changelog sai dele.
4. Benchmark sem regressão > 10% (a partir do M2).
