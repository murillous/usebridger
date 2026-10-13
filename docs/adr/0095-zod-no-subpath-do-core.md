# ADR 0095 — Zod do core no subpath `@usebridger/core/zod`

**Status:** Aceito (2026-10-13) · Detalha **D17** ([ADR 0017](0017-config-por-plugin-zod.md)) e
**D34** ([ADR 0034](0034-biblioteca-sem-runner.md))

## Contexto

A config do plugin é um schema Zod (D17), mas o core não reexporta o `z`: o app instala o `zod`
direto e precisa manter a mesma faixa do core. Se as faixas divergirem, o app fica com duas
cópias, o `PluginDefinition<TSchema extends z.ZodType>` do core é tipado por uma e o schema sai da
outra, com erros de tipo pouco claros (#86).

O core importa o Zod só como tipo: carregar o módulo cria `globalThis.__zod_globalRegistry`, e
importar o core não pode ter side effect (D04, conferido no `no-side-effects.test.ts`). Por isso
reexportar o `z` no `@usebridger/core` não serve.

Alternativas consideradas: `z` no `@usebridger/core`, abrindo exceção ao D04; `zod` como
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
  de depreciação dos outros depois da 1.0 (D27).
- Quem preferir instalar o `zod` direto continua podendo; o risco das duas cópias fica com ele.
