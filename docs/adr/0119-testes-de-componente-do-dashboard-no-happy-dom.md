# ADR 0119 — Testes de componente do dashboard no happy-dom

**Status:** Aceito (2026-10-18) · Usa **D107** ([ADR 0107](0107-plugins-oficiais-de-metricas-e-dashboard.md))

## Contexto

O app web do `plugin-dashboard` tem testes só para a lógica pura de `web/src/lib`, em Node. As
páginas React (`web/src/pages`) não têm nenhum: cada mudança de tela, como o título, o tom e o
rótulo de envio das abas (#189), é conferida à mão no browser.

Testar componente pede um DOM: efeitos (`useEffect` carrega os widgets), clique, envio de form e
rótulo acessível. O repo não tinha nenhum.

Alternativas consideradas:

- **`react-dom/server` (`renderToStaticMarkup`)**, sem dependência nova. Só a primeira renderização:
  não roda efeito, não carrega dado, não clica. Não pega o tom do `stats`, que vem do `load`.
- **jsdom.** Mais completo que o happy-dom, mais lento para subir, e o app não usa nada que o
  happy-dom não tenha.
- **Browser real (Vitest browser mode, Playwright).** Fiel, mas pede binário de browser no CI para
  testar o que o happy-dom já cobre.

## Decisão

- **happy-dom com a Testing Library** (`@testing-library/react`, `@testing-library/dom`,
  `@testing-library/user-event`), só em `devDependencies` do `plugin-dashboard`.
- **Ambiente por arquivo:** `// @vitest-environment happy-dom` no topo de cada `*.test.tsx`. O
  projeto do pacote segue em Node; não há config de Vitest por pacote.
- **Sem servidor:** o teste troca o `fetch` por um stub que responde por caminho. O contrato
  servidor-browser já é testado do lado do servidor (`src/*.test.ts`).
- **Consulta por papel e nome** (`getByRole`), para o teste cobrir também o rótulo acessível.
- **`#web/*` no `imports` do `package.json`**, o mesmo mapa do `tsconfig` e do Vite, para o Vitest
  resolver o alias sem config própria.

## Consequências

- Mudança de tela ganha teste como o resto, e a conferência manual vira exceção.
- Quatro dependências de dev a mais no pacote; nada muda no que é publicado.
- O happy-dom não faz layout: largura, media query e CSS não são testados. O comportamento abaixo
  de 768 px segue na conferência manual.
