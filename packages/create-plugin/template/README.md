# __package__

Plugin do [Bridger](https://github.com/murillous/usebridger). Responde `!ola` cumprimentando quem
chamou e expõe quantas vezes cada pessoa foi cumprimentada na API do core, no recurso
`GET /api/resources/__name__/saudacoes` (permissão `__name__.read`).

## Usar no bot

```sh
npm install __package__
```

```ts
import { createBot } from '@usebridger/core';
import { __export__ } from '__package__';

const bot = createBot({ transport, plugins: [__export__] });
await bot.start();
```

## Desenvolver

| Comando | O que faz |
| --- | --- |
| `npm test` | Roda os testes (Vitest + `@usebridger/testing`), sem rede e sem WhatsApp |
| `npm run typecheck` | Confere os tipos |
| `npm run build` | Gera `dist/` (JS e `.d.ts`) |
| `npm run changeset` | Registra uma mudança para o changelog |

O plugin fica em `src/index.ts`, na forma curta: comandos em `commands` e eventos em `on`, direto
no manifesto. O `setup(ctx)` entra quando precisar de algo dinâmico (registrar sob condição da
config, rotas HTTP, serviços). Nele, o `ctx.services.contribute('api.resources', ...)` publica
dados do plugin na API sem escrever UI: o dashboard, ou outro app, desenha a tela pelo schema
([Recursos de plugin](https://github.com/murillous/usebridger/blob/main/packages/core/docs/api.md#recursos-de-plugin)).

## Rodar em qualquer plataforma

O mesmo plugin roda no WhatsApp, no Telegram, no Discord e no chat web, se seguir três regras:

- **`requires` só com o essencial.** O plugin que exige uma capability que o transport não tem
  derruba o boot. Para degradar por transport, ponha o `requires` no comando: só ele fica de
  fora. O que é opcional se confere em runtime: `capabilities.has('reactions')`.
- **Formatação pelos helpers.** `fmt`, `bold`, `italic`, `code`, `link` e `mention` viram a
  marcação de cada plataforma. `*negrito*` escrito à mão só funciona no WhatsApp.
- **Teste em todos os perfis.** O `describe.each(PROFILE_NAMES)` do teste roda o plugin com as
  capabilities e o remetente de cada plataforma.

## Publicar

Versão e changelog saem dos changesets ([`.changeset/README.md`](.changeset/README.md)). O
`version` do manifesto em `src/index.ts` acompanha o do `package.json`.
