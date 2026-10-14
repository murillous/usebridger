# AGENTS.md

`__package__` é um plugin do [Bridger](https://github.com/murillous/usebridger), kernel de bot de
mensageria. O plugin (`name: '__name__'`, export `__export__`) fica em `src/index.ts` e o teste em
`src/index.test.ts`.

## Comandos

| Comando | Quando |
| --- | --- |
| `npm install` | Uma vez, depois de clonar |
| `npm test` | Depois de cada mudança: Vitest + `@usebridger/testing`, sem rede |
| `npm run typecheck` | Antes de entregar |
| `npm run build` | Gera `dist/` (JS e `.d.ts`) |
| `npm run changeset` | Toda mudança que quem usa o plugin precisa saber |

## Regras do plugin

- **`requires` só com o essencial.** Plugin que exige uma capability que o transport não tem é
  ignorado no boot. O que é opcional se confere em runtime: `ctx.capabilities.has('reactions')`.
- **Tudo que o `setup` cria, o `teardown` libera** (timer, listener, conexão), ou se amarra ao
  `ctx.signal`. Config mudou ou o plugin foi recarregado: o contexto antigo é descartado, e o que
  ficou solto roda em dobro.
- **Trabalho de fundo respeita o `signal`.** `fetch`, timers e loops recebem o `signal` do
  contexto (`ctx.signal` no plugin, `c.signal` no comando) e param quando ele aborta, senão
  passam do prazo e sobrevivem ao reload.
- **Formatação pelos helpers.** `fmt`, `bold`, `italic`, `code`, `link` e `mention` viram a
  marcação de cada plataforma. `*negrito*` à mão só funciona no WhatsApp.
- **`ctx.unsafe` não é atalho.** Ele expõe o objeto bruto de uma plataforma e prende o plugin a
  ela. Se falta algo na API pública, é lacuna do core: abra issue no Bridger.
- **Teste em todos os perfis.** Mantenha o `describe.each(PROFILE_NAMES)`: o mesmo teste roda como
  WhatsApp, Telegram, Discord e web. Teste num perfil só esconde o plugin que não é portátil.
- **Versão em sincronia.** O `version` do manifesto em `src/index.ts` é o mesmo do
  `package.json`; o `changeset version` só mexe no `package.json`, então atualize os dois juntos.
- **Config com o `z` do core.** O schema vem de `import { z } from '@usebridger/core/zod'`, não
  do pacote `zod`: uma segunda cópia do Zod dá erros de tipo confusos no `definePlugin`.
- **`dependsOn` no 0.x:** `^0.0.z` aceita só a versão exata `0.0.z`. Use `^0.M.0` ou `0.x`.

## Documentação

- **Tipos e JSDoc**, na versão instalada: `node_modules/@usebridger/core/dist/*.d.mts` e
  `node_modules/@usebridger/testing/dist/*.d.mts`.
- **Guias do autor de plugin:** https://github.com/murillous/usebridger/tree/main/docs/guias
- **Como cada módulo do core funciona:**
  https://github.com/murillous/usebridger/tree/main/packages/core/docs
