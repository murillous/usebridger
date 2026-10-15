# ADR 0103 — Site de documentação com Starlight

**Status:** Aceito (2026-10-15) · Detalha **D85** ([ADR 0085](0085-release-a-partir-da-main.md))

## Contexto

A documentação do Bridger vivia só em Markdown dentro do repositório (`docs/`, `packages/*/docs`,
ADRs) e na referência de API gerada por um pacote à parte (`tooling/typedoc`). Quem chega ao
projeto não tinha uma porta de entrada: sem busca, sem navegação, sem getting started que se
pudesse copiar e rodar, e nada que um agente de IA lesse de uma vez (#91).

## Decisão

- **Starlight (Astro) em `site/`**, pacote privado `@usebridger/site`. Pesou a favor: i18n
  nativo, busca Pagefind sem serviço externo e os plugins `starlight-typedoc` (API) e
  `starlight-llms-txt`. Alternativas descartadas: **VitePress**, que tem
  `typedoc-vitepress-theme` e `vitepress-plugin-llms` e serviria; o que pesou foi o i18n e a busca
  integrados, que lá pedem montagem própria. **Docusaurus** (mais pesado,
  com React e versionamento que o projeto não usa).
- **O Markdown fica onde está** (`docs/`, `packages/*/docs`, `docs/adr/`) e é sincronizado para
  o site no build (`site/scripts/sync-content.ts`). O GitHub continua mostrando a mesma
  documentação e não há cópia para manter. Páginas escritas à mão (home, getting started) vivem
  em `site/src/content/docs/`.
- **GitHub Pages em `https://murillous.github.io/usebridger`**, publicado pelo `docs.yml` a cada
  push na `main`, que só recebe a `develop` no release (ADR 0085). O deploy roda no merge da
  `develop`, um pouco antes de o PR de versão publicar no npm: o site pode adiantar a API por
  alguns minutos ou horas. Aceito. O PR roda só o build, no job
  `Docs` do `ci.yml`: link quebrado (`starlight-links-validator`) ou warning do TypeDoc
  (`treatWarningsAsErrors`) falha o PR.
- **PT-BR na raiz, EN estruturado.** O português é o idioma de verdade; o inglês existe como
  locale com fallback para o português, para ser preenchido sem mexer na estrutura.
- **Versão única até o 1.0.** Sem seletor de versões: o site descreve o `main` publicado. Versionar
  antes de haver uma API estável só multiplicaria páginas.
- **TypeDoc absorvido no site.** A referência da API é gerada pelo `starlight-typedoc` a partir do
  fonte; o pacote `tooling/typedoc` deixa de existir.
- **`llms.txt` e `llms-full.txt`** pelo `starlight-llms-txt`, sem as ADRs (registro histórico) e
  sem a API gerada no `full`, que o inflaria; ambas ficam como conjuntos à parte listados no índice. O
  plugin só aplica `exclude` ao `small`, então o `llms-full.txt` usa um patch
  (`patches/starlight-llms-txt@0.12.0.patch`, via `patchedDependencies`) até isso ir ao upstream.
- **Exemplos do getting started são pacotes em `examples/`** (privados, parte do workspace). O
  typecheck e o teste do CI os verificam; o site mostra o código desses arquivos, não uma cópia
  que envelheça.
- **A `docs/` de cada pacote entra no tarball do npm** (`"files": ["dist", "docs"]`), para a
  documentação viajar com a versão instalada.

## Consequências

- Documentação nova é Markdown comum no lugar de sempre; o site a recolhe sozinho.
- Todo PR paga o build do site (job `Docs`), em troca de links e exemplos que não quebram em
  silêncio.
- O patch do `starlight-llms-txt` precisa ser revisto a cada atualização do plugin.
- O site mostra só a versão da `main`; quem usa uma versão antiga lê o `docs/` do tarball dela.
- Deploy depende do Pages com source "GitHub Actions" ativado no repositório.
