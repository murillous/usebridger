# ADR 0091 — Zod do core no subpath `@usebridger/core/zod`

**Status:** Aceito (2026-10-13) · Detalha **D15** ([ADR 0015](0015-config-por-plugin-zod.md)) e
**D30** ([ADR 0030](0030-biblioteca-sem-runner.md))

## Contexto

A config do plugin é um schema Zod (D15), mas o core não reexporta o `z`: o app instala o `zod`
direto e precisa manter a mesma faixa do core. Se as faixas divergirem, o app fica com duas
cópias, o `PluginDefinition<TSchema extends z.ZodType>` do core é tipado por uma e o schema sai da
outra, com erros de tipo pouco claros (#86).

O core importa o Zod só como tipo: carregar o módulo cria `globalThis.__zod_globalRegistry`, e
importar o core não pode ter side effect (D03, conferido no `no-side-effects.test.ts`). Por isso
reexportar o `z` no `@usebridger/core` não serve.

Alternativas consideradas: `z` no `@usebridger/core`, abrindo exceção ao D03; `zod` como
`peerDependency` do core, que garante a cópia única mas passa ao app a responsabilidade pela
versão; só documentar a faixa compatível, que quebra no primeiro bump.

## Decisão

- Novo ponto de entrada `@usebridger/core/zod`, que exporta só `z`, o mesmo módulo da
  dependência `zod` do core: `import { z } from '@usebridger/core/zod'`.
- O `@usebridger/core` e os outros pontos de entrada seguem sem carregar o Zod. O global do Zod
  passa a existir só para quem importa o subpath, que é quem já ia carregar o Zod de qualquer
  forma.
- O `zod` segue como `dependency` do core. A doc de config e os exemplos usam o subpath.

## Consequências

- O app não instala o `zod` e não acompanha a faixa dele; a versão do Zod passa a seguir a do
  core.
- Bump major do Zod no core vira mudança da API pública deste ponto de entrada, com o mesmo ciclo
  de depreciação dos outros depois da 1.0 (D24).
- Quem preferir instalar o `zod` direto continua podendo; o risco das duas cópias fica com ele.
