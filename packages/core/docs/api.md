# API HTTP

O core expõe uma API HTTP descrita em OpenAPI 3.2 sobre o [servidor HTTP](http.md)
([ADR 0125](../../../docs/adr/0125-api-http-do-core-e-dashboard-cliente.md),
[ADR 0126](../../../docs/adr/0126-rotas-da-api-de-plugin-sob-api-plugins.md)). Sem auth ainda
fica aberta até ligar `api.auth` (veja [Autenticação](#autenticação)): sem ela, não exponha a porta
fora de uma rede confiável.

| Sessão | Base da API | Spec |
| --- | --- | --- |
| `default` | `/api` | `GET /openapi.json` |
| outra (`erp`) | `/sessions/erp/api` | `GET /openapi.json` (uma spec para o processo todo) |

`GET /api/health` é a operação de exemplo (mesmos dados do `/health`, que continua no ar).

## Registrar uma operação

```ts
import { ApiError, definePlugin } from '@usebridger/core';
import { z } from 'zod';

export default definePlugin({
  name: 'tarefas',
  version: '1.0.0',
  engine: '>=0.9.0',
  setup(ctx) {
    ctx.http.api({
      method: 'GET',
      path: '/items/:id', // vira GET /api/plugins/tarefas/items/:id
      summary: 'Busca um item',
      params: z.object({ id: z.string().regex(/^\d+$/) }),
      query: z.object({ verbose: z.enum(['0', '1']).default('0') }),
      response: z.object({ id: z.string() }).meta({ id: 'Item' }), // `id` vira componente
      handler: ({ params, query }) => {
        if (params.id === '0') throw new ApiError(404, 'item não existe');
        return { id: params.id };
      },
    });
  },
});
```

- O caminho é relativo ao dono: `/api/plugins/<nome>` no plugin. Mesmo método e caminho duas vezes lança `HttpRouteConflictError`.
- `/config`, `/enable` e `/disable` (e o que vier abaixo deles) são do core
  ([plugins e config](#plugins-e-config)); a operação de plugin ali lança `BotConfigError`.
- `params`, `query` e `body` são opcionais; presentes, o core valida antes do handler. `body` é
  JSON. `status: 201` troca o status de sucesso.
- `response` só alimenta a spec: o core não confere o retorno do handler.
- Query string repetida chega como array; use `z.coerce` para números.
- A porta só abre se algum plugin ou transport registrar rota; sozinha, a API do core não abre.

## Recursos de plugin

([ADR 0134](../../../docs/adr/0134-recursos-de-plugin-pela-api.md).) Para expor dados que um
frontend lista, abre e edita, declare um **recurso** no ponto `api.resources` em vez de escrever
cada operação. O core monta as rotas, a validação, a auth e a spec; o plugin não declara UI, e o
dashboard (ou outro app) desenha a tela a partir do schema.

```ts
import { ApiError, definePlugin, defineResource } from '@usebridger/core';
import { z } from '@usebridger/core/zod';

type Linha = { nome: string; pontos: number };

export const ranking = definePlugin({
  name: 'rank',
  version: '1.0.0',
  engine: '>=0.9.0',
  setup(ctx) {
    const linhas = ctx.storage.collection<Linha>('linhas', { indexes: ['pontos'] });
    ctx.services.contribute(
      'api.resources',
      defineResource({
        id: 'ranking',
        schema: z.object({ id: z.string(), nome: z.string(), pontos: z.number() }).meta({ id: 'RankRow' }),
        permissions: { read: 'rank.read', write: 'rank.write' },
        filter: z.object({ min: z.coerce.number().optional() }), // campos da query string
        list: async ({ cursor, limit, filter }) => {
          const offset = cursor === undefined ? 0 : Number(cursor);
          const items = await linhas.find({
            ...(filter.min !== undefined && { where: { pontos: { gte: filter.min } } }),
            orderBy: { field: 'pontos', direction: 'desc' },
            offset,
            limit: limit + 1,
          });
          return {
            items: items.slice(0, limit),
            cursor: items.length > limit ? String(offset + limit) : undefined,
          };
        },
        get: ({ id }) => linhas.get(id), // `undefined` vira 404
        actions: [
          {
            id: 'zerar',
            permission: 'rank.reset', // sem ela, vale `permissions.write`
            input: z.object({ motivo: z.string().min(3) }),
            confirm: true, // o frontend pede confirmação antes
            run: async ({ id }) => {
              if ((await linhas.update(id, { pontos: 0 })) === 0) {
                throw new ApiError(404, 'linha não existe');
              }
            },
          },
        ],
      }),
    );
  },
});
```

| Operação | Rota sob `/api/resources/<plugin>/<id>` | Permissão | Retorno do handler |
| --- | --- | --- | --- |
| `list({ cursor, limit, filter, actor })` | `GET` na coleção; `limit` 1–100, padrão 20 | `read` | `{ items, cursor? }`; o cliente devolve o `cursor` para a próxima página |
| `get({ id, actor })` | `GET /{id}` | `read` | o item; `undefined` é 404 |
| `create: { input, run({ input, actor }) }` | `POST` na coleção, 201 | `write` | o item criado |
| `update: { input, run({ id, input, actor }) }` | `PATCH /{id}` | `write` | o item; `undefined` é 404 |
| `delete({ id, actor })` | `DELETE /{id}`, responde `{ id }` | `write` | `false` é 404 |
| `actions[]: { id, summary?, input?, output?, permission?, confirm?, run({ id, input, actor }) }` | `POST /{id}/actions/<ação>` | a da ação, ou `write` | o `output`; sem ele, `{}` |

- **Tudo é opcional**, mas o recurso precisa de ao menos uma operação. A ausente não vira rota (404)
  nem entra na spec.
- **Entrada inválida** (query, `input` do create, do update ou da ação) é 400 com `errors`, antes do
  handler. Para os outros 4xx, `throw new ApiError(...)`.
- **Permissões** no formato `<área>.<ação>`. Sem `permissions.read`, ler exige só estar autenticado.
  As do plugin entram no catálogo da auth enquanto ele estiver carregado: `owner` e `admin` as têm,
  `viewer` só as `.read`, e elas valem no escopo de uma API key. Prefixe pela área do plugin
  (`rank.*`): dois plugins com o mesmo nome dividem a permissão. Vale também para a `permission` das
  operações de `ctx.http.api`.
- **`actor`** traz `id`, `kind` (`user` ou `key`), `name`, `onBehalfOf?` e `can(permissão)`, para
  filtrar os dados por quem chama. Com a auth desligada (loopback), fica `undefined`.
- **Spec**: cada operação sai com `x-permission`, `x-resource`
  (`{ plugin, resource, operation, action?, confirm? }`) e a tag `resources:<plugin>/<id>`. Dê
  `.meta({ id })` ao schema do item para ele virar componente nomeado.
- **Validação no `contribute`**: id fora de `[a-z0-9-]`, até 40, schema que não é Zod, permissão fora
  do formato, `filter` com `cursor` ou `limit`, ação repetida ou nenhuma operação lançam
  `BotConfigError` e falham o `setup`. O mesmo `id` duas vezes no plugin também.
- **Ciclo de vida**: o recurso sai da API e da spec no teardown, reload e disable do plugin, e volta
  no enable. Sem `http` no `createBot`, ele só fica no ponto (`ctx.services.extensionPoint`).

### Migrar do `dashboard.tabs`

O `dashboard.tabs` (ADR 0104, 0109, 0114) saiu com o dashboard novo (M7-10), que mostra cada
recurso numa tela genérica. Cada widget vira dado num recurso, e o desenho fica com o frontend:

| Widget da aba | No recurso |
| --- | --- |
| `table` (`columns`, `load({ cursor })`, linhas com `id`) | `schema` do item (uma coluna por campo) e `list` devolvendo `{ items, cursor }` |
| `table.actions` (`id`, `label`, `confirm`, `run({ row })`) | `actions` (`id`, `summary`, `confirm`, `run({ id })`): o `id` da linha chega pelo caminho |
| `form` (`schema`, `submit(input)`) | `create: { input: schema, run }`, ou uma ação com `input` quando não cria item |
| `stats` (`load()` → `{ label, value }[]`) | recurso com `list` devolvendo um item por número (`{ id, label, value }`) |
| `series` (`load({ days })`) | `list` com `filter: z.object({ days: z.coerce.number() })` e um item por ponto |
| `text` (`markdown`) | fica no frontend: não é dado |
| `title`, `tone`, `order`, `submitLabel` | ficam no frontend: são decisões de UI |

Antes:

```ts
ctx.services.contribute('dashboard.tabs', {
  id: 'lembretes',
  title: 'Lembretes',
  widgets: [{
    kind: 'table',
    id: 'pendentes',
    columns: [{ key: 'texto', label: 'Texto' }],
    load: async () => ({ rows: await pendentes() }),
    actions: [{ id: 'cancelar', label: 'Cancelar', confirm: true, run: ({ row }) => cancelar(row.id) }],
  }],
});
```

Depois:

```ts
ctx.services.contribute('api.resources', defineResource({
  id: 'lembretes',
  schema: z.object({ id: z.string(), texto: z.string() }),
  permissions: { read: 'lembretes.read', write: 'lembretes.manage' },
  list: async () => ({ items: await pendentes() }),
  actions: [{ id: 'cancelar', summary: 'Cancelar', confirm: true, run: ({ id }) => cancelar(id) }],
}));
```

Na aba, `row` vinha do browser e só o `id` era confiável. No recurso, o `id` vem do caminho, o
`input` chega validado pelo schema e a permissão é conferida antes do handler.

## Erros (problem+json)

Todo erro sob a API sai como `application/problem+json` (RFC 9457) e o componente `Problem` da
spec:

```json
{ "type": "about:blank", "title": "Bad Request", "status": 400, "detail": "entrada inválida",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "errors": [{ "in": "path", "path": "id", "message": "Invalid string", "code": "invalid_format" }] }
```

| Situação | Status |
| --- | --- |
| Params, query ou body inválidos (inclui JSON ilegível) | 400 com `errors` |
| `throw new ApiError(401 \| 403 \| 404 \| 409, detalhe)` | o status pedido |
| Caminho desconhecido sob `/api` | 404 |
| Qualquer outro erro do handler | 500 sem `detail` nem stack; o erro vai para o log (`plugin.error` com `phase: 'http'` no plugin, `http.unhandled` no core) |

O `traceId` é o do [ADR 0120](../../../docs/adr/0120-trace-e-trilha-de-eventos.md): o mesmo que
aparece nas linhas de log da requisição.

## Ler a spec

`GET /openapi.json` monta o documento a cada pedido, a partir da tabela atual de rotas (core e
plugins, inclusive os que carregaram depois do boot). Sem servidor, para o CLI ou um build:

```ts
import { coreApiRoutes, createOpenApiDocument } from '@usebridger/core';

const spec = await createOpenApiDocument(await coreApiRoutes()); // só o core; aceita { version }
```

`createOpenApiDocument` recebe qualquer lista de `{ path, operation }` (`ApiRoute`).

## Gerar a spec e o cliente

O comando `bridger openapi [módulo] [--out <arquivo>]` escreve a spec OpenAPI 3.2 (JSON) no
stdout, ou em `--out`, sem conectar transport nem abrir porta:

```sh
bridger openapi --out openapi.json              # só o core
bridger openapi ./src/plugins.ts --out openapi.json  # core + plugins do app
```

O módulo é um arquivo do app que exporta, por named export, a lista de plugins:
`export const plugins = [meuPlugin, outroPlugin]` (a mesma lista que vai na config do bot). O
comando o importa, e isso é seguro porque importar o módulo do app não tem efeito colateral
([ADR 0003](../../../docs/adr/0003-uma-sessao-por-processo.md)).

Para coletar as operações, o comando roda o `setup` de cada plugin (prazo de 10 s, e depois o
`teardown`, com `ctx.signal` abortado) com um contexto em que só `ctx.http`, `ctx.plugin`,
`ctx.signal`, `ctx.config` e o `ctx.services.contribute('api.resources', ...)` são reais. `ctx.config` traz os defaults do schema do plugin; se o
schema tem campo obrigatório, `config` e o resto de `ctx` (storage, scheduler, commands) viram um
no-op. O kernel não toca em nada externo, mas o código do próprio plugin roda: registre a API no
começo do `setup` e deixe conexões e timers para depois. Operações registradas sob condição da
config real podem não bater com as do runtime. Uso inválido ou `setup` que falha saem com código 1
e mensagem no stderr.

Módulo `.ts` depende do type-stripping do Node: sem `enum`, com imports usando a extensão `.ts` e
sem os aliases do tsconfig. Se o app usa algo disso, passe o `.js` do build.

Tipos e cliente no frontend (o `openapi-typescript` roda isolado em TypeScript 5,
[ADR 0125](../../../docs/adr/0125-api-http-do-core-e-dashboard-cliente.md); não é dependência do core):

```sh
pnpm dlx --package typescript@5 --package openapi-typescript@7.13.0 openapi-typescript openapi.json -o src/api-types.d.ts
```

```ts
import createClient from 'openapi-fetch'; // fixe a versão exata no package.json do frontend
import type { paths } from './api-types';

const api = createClient<paths>({ baseUrl: 'http://localhost:3000' });
const { data, error } = await api.GET('/api/health'); // `error` é o problem+json tipado
```

## CORS

Desligado por padrão: sem config, a API não manda header CORS e o preflight `OPTIONS` não é
respondido. Para um painel em outra origem:

```ts
createBot({ http, api: { cors: { origins: ['https://painel.exemplo.com'] } }, ... });
```

Origem exata (esquema, host e porta), sem curinga. Só origem da lista recebe
`Access-Control-Allow-Origin` (com `Allow-Credentials: true` e `Vary: Origin`); o preflight
dessas origens responde 204. Com o CORS ligado, toda resposta leva `Vary: Origin`. Vale para `/api` e para `/openapi.json` (união das origens das sessões).

## Snapshot da spec do core

A spec do core fica versionada em `packages/core/src/api/__snapshots__/openapi.json`, e o teste
`src/api/api.test.ts` falha (no CI também, via `pnpm test`) se ela mudar sem o arquivo mudar.

Mudança proposital: rode `pnpm exec vitest run packages/core/src/api -u`, confira o diff do
arquivo no PR e crie o changeset. A spec é contrato semver: remover ou mudar rota, campo ou enum
exige changeset **`major`** do `@usebridger/core`; acrescentar é `minor`.

## Autenticação

([ADR 0127](../../../docs/adr/0127-base-da-autenticacao-da-api.md).) Ligue com `api: { auth: {} }` no `BotConfig`
(`sessionIdleMs`, padrão 8 h, e `sessionMaxAgeMs`, padrão 7 d, são opcionais; o máximo absoluto vale na criação da sessão, no login). Daí em diante toda
operação, do core e de plugin, exige um ator:

- cookie `bridger_session` (pessoa) ou `Authorization: Bearer <chave>` (máquina);
- `permission: 'logs.read'` na operação exige essa permissão (403 e evento `kernel.auth.denied`
  se faltar); sem `permission`, basta estar autenticado; `public: true` dispensa a auth;
- o handler recebe o ator em `input.actor`, e `ctx.audit` grava com ele.

```ts
ctx.http.api({
  method: 'GET',
  path: '/logs',
  permission: 'logs.read',
  response: z.object({ lines: z.array(z.string()) }),
  handler: ({ actor }) => ({ lines: [`lido por ${actor?.name}`] }),
});
```

Papéis: `owner` e `admin` têm todas as permissões do core e as dos plugins carregados
([recursos de plugin](#recursos-de-plugin)); `viewer`, só as `.read`. O admin não
gerencia owner (`canManageRole`). A spec traz `securitySchemes` (`cookieAuth`, `bearerAuth`),
`security` por operação e `x-permission`.

### Auth obrigatória fora de loopback

(ADR 0128.) Sem `api.auth`, a API fica aberta, então o bot só sobe se o `hostname` de
`createHttp` for loopback (`127.0.0.1`/`127.0.0.0/8`, `::1`, `localhost`). Hostname ausente
(escuta em todas as interfaces), `0.0.0.0`, `::` ou outro faz o `createBot` lançar `BotConfigError`.
Corrija configurando `api.auth` ou usando `createHttp({ port, hostname: '127.0.0.1' })`.

### Configurar a auth e o CORS

```ts
createBot({
  http, storage,
  api: {
    auth: {
      bootstrapToken: appEnv.BRIDGER_BOOTSTRAP_TOKEN, // 16+ caracteres; só para o primeiro acesso
      sessionIdleMs: 8 * 3_600_000, // inatividade (padrão 8 h)
      sessionMaxAgeMs: 7 * 24 * 3_600_000, // vida absoluta (padrão 7 d)
      trustProxy: 1, // proxies confiáveis na frente (padrão 0: usa o IP do socket)
    },
    cors: { origins: ['https://painel.exemplo.com'] }, // só se o frontend está em outra origem
  },
});
```

- **Mesma origem**: o cookie sai `bridger_session=...; Path=/; HttpOnly; Secure; SameSite=Strict`.
- **Origem cruzada** (`api.cors.origins`, request de origem da lista): o cookie sai
  `SameSite=None; Secure`, e toda escrita (`POST`, `PUT`, `PATCH`, `DELETE`) vinda de um browser
  (request com `Origin`) precisa do header `X-Bridger-CSRF` com qualquer valor não vazio; sem ele a
  resposta é 403. O browser só deixa um site mandar o header se a origem passou no preflight do CORS.
  O frontend faz `fetch(url, { credentials: 'include', headers: { 'X-Bridger-CSRF': '1' } })`.
  Quem usa `Authorization: Bearer` não precisa do header.

- **Atrás de proxy** (`trustProxy: N`): o IP do cliente, usado no rate limit e na auditoria, é o
  N-ésimo de trás para frente do `X-Forwarded-For`. Use o número exato de proxies que acrescentam o
  header; com valor maior que o real o cliente forja o IP e escapa do limite. O padrão (0) usa o
  endereço do socket, e atrás de proxy todos os clientes dividem o mesmo limite por IP.
- **Cookie por sessão do servidor**: `Path=<prefixo>/api`, então bots em `/sessions/<nome>/api`
  não sobrescrevem o cookie um do outro.

### Primeiro acesso (bootstrap)

Sem nenhum usuário, o `bootstrapToken` vale como convite do primeiro `owner`:

```bash
curl -X POST $URL/api/auth/invites/accept -H 'content-type: application/json' \
  -d '{"token":"<bootstrapToken>","name":"Dona","email":"dona@exemplo.com","password":"uma senha longa"}'
```

A resposta já traz o cookie da sessão. Com o primeiro usuário criado, o token não vale mais; dois
aceites simultâneos criam um owner só (o outro leva 400).

### Rotas de login e usuários

| Rota | Quem |
| --- | --- |
| `POST /api/auth/login` `{ email, password }` | público; 5 falhas em 15 min por IP e por e-mail bloqueiam (429 com `Retry-After`, espera dobrando a cada falha); a falha é sempre `401 e-mail ou senha inválidos` |
| `POST /api/auth/logout`, `GET /api/auth/me` | autenticado |
| `GET /api/auth/sessions`, `DELETE /api/auth/sessions/:id` | minhas sessões (pessoa; API key leva 403) |
| `POST /api/auth/password` `{ currentPassword, newPassword }` | encerra as outras sessões; senha atual errada é 403, com limite por usuário |
| `POST /api/auth/invites/accept` `{ token, password }` | público; define a senha e entra |
| `POST /api/users` `{ name, email, role }` | `users.manage`; devolve o convite **uma vez** |
| `GET /api/users`, `GET` e `PATCH /api/users/:id` | `users.manage` |
| `POST /api/users/:id/disable` e `/enable` | desativar encerra as sessões na hora; nunca se apaga |
| `DELETE /api/users/:id/sessions`, `POST /api/users/:id/reset-password` | encerra sessões; novo convite e senha antiga invalidada |

Convite: uso único, vale 48 h, guardado só como hash. Admin não gerencia owner, e o último owner
ativo não pode ser desativado nem rebaixado (409); e-mail repetido também leva 409. Essas três
regras (primeiro owner, e-mail único, último owner) rodam sob uma trava curta no storage
(ADR 0128), então valem com requests e processos simultâneos. A trava é um lease de 15 s: supõe
relógios sincronizados entre os processos (NTP) e seção crítica bem abaixo disso. Quem não a
pega em até 5 s recebe `409 conta em uso por outra operação; tente de novo`, e depois de uma
queda no meio da operação as rotas de cadastro, bootstrap, papel e status podem dar esse 409 por
até ~15 s, até o lease vencer sozinho. Cada ação grava na auditoria
(`kernel.auth.login`, `kernel.auth.login.failed`, `kernel.auth.logout`,
`kernel.auth.invite.created` e `.accepted`, `kernel.user.created`, `.updated`, `.disabled`,
`.enabled`, `kernel.auth.sessions.revoked`, `kernel.auth.password.changed`). Recusas de papel (admin sobre owner) e de CSRF saem como
`kernel.auth.denied` com o ator. O IP vai no campo `ip` do evento.

### Recuperação (sem owner ativo)

Se não sobrou owner ativo, gere um convite pela CLI. O módulo do app exporta o mesmo `storage` do
bot (e `session`, se não for a `default`):

```bash
bridger owner-invite ./app.ts --email dona@exemplo.com --name "Dona"
```

O módulo deve **só exportar `storage` (e `session`)**, sem efeito colateral: use um arquivo à parte
e tomaria a trava da sessão). A CLI não toma a trava da sessão (`session:<nome>`), então roda com o bot
no ar. É seguro porque a checagem e a escrita do owner rodam sob as travas `users`/`owners` no storage
(ADR 0128), que valem entre processos: se o bot segura uma delas, a CLI espera até 5 s e, passado isso,
sai com erro claro (409) sem criar nada. SQLite: dois processos no mesmo arquivo em WAL com
`busy_timeout` de 5 s, sem `SQLITE_BUSY`. Postgres: dois clientes no mesmo banco, com `UPDATE`
condicional. O uso único do convite é do aceite no bot, não da CLI.

Imprime o token uma vez; aceite-o em `/api/auth/invites/accept`. Cria o usuário ou promove o do
e-mail a owner sem senha, e recusa se já existe owner ativo. A CLI não grava na auditoria (roda
fora do bot). O limite de login fica no storage (coleção `rateLimits`) e sobrevive a restart.

### Criar uma API key

Quem tem `keys.manage` (owner/admin, ou outra chave com ela) cria chaves em `POST /api/keys`:

```sh
curl -X POST http://localhost:3000/api/keys \
  -H "Authorization: Bearer $BRIDGER_KEY" -H 'content-type: application/json' \
  -d '{ "name": "backend-do-app", "permissions": ["logs.read", "auth.on-behalf-of"] }'
```

A resposta traz `secret` (`brk_...`) **uma única vez**; o storage guarda só o hash. O escopo só
aceita permissões do core ou de plugin carregado (senão 400) e só as que quem cria também tem
(senão 403). `GET /api/keys` lista com
`lastUsedAt` e `revokedAt`, sem o segredo; `DELETE /api/keys/:id` revoga (a chave passa a dar 401).
Criar e revogar geram os eventos `kernel.key.created` e `kernel.key.revoked` na auditoria.

A permissão efetiva de uma chave é o escopo dela **∩ as permissões atuais do criador**
(`createdBy`, ADR 0128). Criador rebaixado: a chave perde o que ele não tem mais (403 na operação).
Criador desativado ou removido, ou chave-criadora revogada: a chave dá 401. Reativar ou repromover
o criador restaura a chave, que não é alterada nem revogada no storage. Chave sem `createdBy`
(criada fora da API) vale pelo escopo próprio; chave criada por chave segue a cadeia.

### Padrão BFF (`X-Bridger-On-Behalf-Of`)

Um app com login próprio guarda uma chave com `auth.on-behalf-of` no backend dele (nunca no
browser) e, a cada chamada, informa quem é a pessoa:

```sh
curl http://localhost:3000/api/plugins/tarefas/items \
  -H "Authorization: Bearer $BRIDGER_KEY" -H 'X-Bridger-On-Behalf-Of: user-42'
```

O valor (1 a 256 caracteres, sem controle) vai para `actor.onBehalfOf` e para o ator dos eventos
de auditoria. Não amplia permissão: vale o escopo da chave. Sem `auth.on-behalf-of`, ou vindo de
sessão de usuário, é 403 auditado. Em frontend de outra origem, o CORS libera o header.

## Plugins e config

Listar, ligar e desligar plugins e editar a config deles, com os segredos cifrados (ADR 0117,
ADR 0131). Mesmas condições das rotas de conexão: sob `/api` (ou `/sessions/<sessão>/api`), com
`BotConfig.http`.

| Rota | Permissão | O que faz |
| --- | --- | --- |
| `GET /plugins` | `plugins.read` | `bootedAt` e cada plugin: `name`, `version`, `status` (`loaded`/`skipped`), `dependsOn`, `services`, `contributions`, `setupMs` e, se `skipped`, `reason: { kind, message }` |
| `POST /plugins/{name}/enable` | `plugins.manage` | Liga o plugin; sobem os dependentes que ele libera. Devolve `{ plugin, dependents }` |
| `POST /plugins/{name}/disable` | `plugins.manage` | Desliga o plugin e os dependentes, até o `enable` |
| `GET /plugins/{name}/config` | `config.read` | `view` (config com segredos em `********`, `messages`, `sources`), `schema` (JSON Schema da entrada) e `secretsWritable` |
| `PUT /plugins/{name}/config` | `config.write` | Grava a config (abaixo) e devolve o mesmo que o `GET` |

Plugin desconhecido é 404. Com a config atual inválida, o `GET` responde 200 com `view: null` e
`issues` (`path`, `message`, `kind`), para o formulário corrigir.

### Gravar a config

O corpo do `PUT` são os **overrides** do plugin, e substitui os salvos (`{}` remove todos). O
`schema` do `GET` gera o formulário: preencha com o `view.config` e devolva o que o usuário
editou.

```sh
curl -X PUT http://localhost:3000/api/plugins/ia/config   -H "Authorization: Bearer $BRIDGER_KEY" -H 'content-type: application/json'   -d '{ "model": "gpt-5", "openai": { "apiKey": "********" } }'
```

- Campo `secret()` com `********`, ou fora do corpo, **mantém** o valor salvo.
- Campo `secret()` com outro valor é segredo novo: gravado cifrado e só com `secrets.write`
  (sem ela, 403 e nada muda). Pede `BRIDGER_SECRET_KEY` (`secretsWritable: true`).
- O core valida a config resultante no schema Zod do plugin. Inválida, responde 400
  (problem+json) com `errors[].path` de cada campo, sem o valor recebido.
- Campo que o env ou o arquivo decidem não aceita segredo salvo: 409.
- Válida, o plugin recarrega com a config nova.

Os segredos novos gravam antes dos overrides, cada um com seu reload. Se os overrides falharem
depois, o segredo fica salvo: confira o `GET` antes de repetir.

Toda escrita entra na auditoria em nome de quem chamou: `kernel.config.update` com o diff
mascarado, `kernel.secret.update` só com o caminho, `kernel.plugin.enable`/`disable`.

## Pseudônimos

`GET /pseudonyms/{pseudonym}` (`pseudonyms.resolve`) devolve o id real de um `u_…`/`g_…` dos logs,
com cada consulta auditada. Detalhes em [Logger](logger.md) e no ADR 0132.

## Auditoria

Consulta, exportação e verificação do log de auditoria (ADR 0122, ADR 0133), com as condições das
rotas de conexão (sob `/api`, com `BotConfig.http`). As três pedem `audit.read`: owner, admin e
viewer.

| Rota | O que faz |
| --- | --- |
| `GET /audit` | Página de eventos por `seq`: `{ events, next? }` |
| `GET /audit/export?format=json\|csv` | Todos os eventos dos filtros, em stream, como anexo |
| `POST /audit/verify` | Confere a cadeia de hash: `{ ok, checked, brokenAt? }` |

Filtros (query string, nos dois `GET`): `from` e `to` (ISO 8601, inclusivos, por `at`), `actor`
(`actorId`), `action`, `target` (`targetId`) e `outcome` (`success`, `denied`, `error`). O
`GET /audit` aceita ainda `limit` (1 a 1000, padrão 100) e `after`, o cursor:

```sh
curl "http://localhost:3000/api/audit?action=kernel.config.update&limit=50"   -H "Authorization: Bearer $BRIDGER_KEY"
# próxima página: o `next` da resposta
curl "http://localhost:3000/api/audit?action=kernel.config.update&limit=50&after=1234"   -H "Authorization: Bearer $BRIDGER_KEY"
# sem `next`, acabou
```

A exportação lê o storage de mil em mil, conforme o cliente consome, e não monta o arquivo na
memória. O JSON é um array de eventos, no formato do `GET /audit`. O CSV tem uma linha de cabeçalho
e uma coluna por campo (`actorKind`, `actorId`, `actorName`, `onBehalfOf`, `targetType`...), com
`details` em JSON; célula que começaria com `=`, `+`, `-` ou `@` leva um `'` na frente para a
planilha não a executar.

```sh
curl -OJ "http://localhost:3000/api/audit/export?format=csv&from=2026-10-01T00:00:00Z"   -H "Authorization: Bearer $BRIDGER_KEY"
```

Cada exportação grava `kernel.audit.export` com o ator da requisição e
`details: { format, filters }`. Falha do storage na primeira página é 500; numa página seguinte, o
200 já saiu: o arquivo vem cortado e o log registra `audit.export.failed`.

O ator chamado pelo BFF traz o `onBehalfOf` (`X-Bridger-On-Behalf-Of`) nas linhas, no JSON e na
coluna do CSV. O `verify` percorre a cadeia inteira; em base grande, prefira rodá-lo fora do
horário de pico ou pelo script do app (ver [Auditoria](audit.md)).

## Logs

`GET /logs` (`logs.read`) devolve as linhas de log recentes do processo, da mais nova para a mais
antiga (ADR 0135). Cada linha tem o formato do `data` do evento `log` do SSE:
`{ level, time, message, fields }`. A rota existe com `BotConfig.http`, como as de conexão.

Filtros (query string): `level` (nível mínimo: `warn` traz `warn`, `error` e `fatal`), `plugin` e
`event` (iguais aos campos da linha), `from` e `to` (ISO 8601, inclusivos), `limit` (1 a 1000,
padrão 100) e `before`, o cursor:

```sh
curl "http://localhost:3000/api/logs?plugin=ia&level=warn&limit=50" -H "Authorization: Bearer $BRIDGER_KEY"
# {"logs":[{"level":"error","time":1761600000000,"message":"…","fields":{"plugin":"ia","event":"…"}}],"next":1234}
# página mais antiga: o `next` da resposta; sem `next`, acabou
curl "http://localhost:3000/api/logs?plugin=ia&level=warn&limit=50&before=1234" -H "Authorization: Bearer $BRIDGER_KEY"
```

- **É memória:** guarda as últimas 1000 linhas por bot. O restart começa vazio; o log durável é o
  do destino do logger (stdout, agregador). O cursor só vale no processo que o deu.
- **Mesmo filtro do SSE:** a linha com o valor do QR ou do código de pareamento só sai para quem tem
  `connection.manage`.
- **Ao vivo:** para acompanhar o que chega, use o stream (`GET /events?types=log`); o `GET /logs`
  preenche o que veio antes.

## Métricas

Com o `plugin-metrics` carregado, o `query` e o `catalog()` do serviço `metrics` saem em
`GET /plugins/metrics/query` e `GET /plugins/metrics/catalog`, com `metrics.read`. As rotas são do
plugin: sem ele, o caminho responde 404 problem+json dizendo que a rota é de um plugin não
carregado. Formato e filtros na [doc do plugin](../../plugin-metrics/docs/README.md#pela-api).

## Conexão e tempo real

Um app conecta o número sem o dashboard (ADR 0129). As rotas ficam sob `/api` (ou
`/sessions/<sessão>/api`) e só existem com `BotConfig.http`. A porta abre quando algum plugin ou o
transport tem rota (ADR 0072).

| Rota | Permissão | O que faz |
| --- | --- | --- |
| `GET /connection` | `connection.read` | Estado (`connecting`/`open`/`closed` e `reason`), transport, `pairing`, conta conectada (`account`), `connectedSince`, `reconnections`, `qrExpiresAt` |
| `POST /connection/pairing-code` | `connection.manage` | Pede o código para `{ "phone": "5511999999999" }` e devolve `{ "code" }` |
| `POST /connection/logout` | `connection.manage` | Desvincula a sessão; o bot limpa a credencial e pareia de novo |
| `GET /events` | `connection.read` | Stream SSE com os eventos abaixo |

Pareamento e logout pedem um transport com a capability `pairing` e os métodos
`requestPairingCode`/`logout` (o `transport-baileys` tem os dois). Sem eles, ou com a sessão já
conectada, a resposta é 409.

### Conectar um número

1. Abra o stream (`GET /events`). Sem `Last-Event-ID`, ele começa com o estado atual: o último
   `connection.status` e, se ainda valer, o QR ou o código.
2. Mostre o `connection.qr` que chegar; a cada QR novo, troque a imagem.
3. Para parear por código em vez do QR, com a sessão em `connecting`:

   ```sh
   curl -X POST http://localhost:3000/api/connection/pairing-code \
     -H "Authorization: Bearer $BRIDGER_KEY" -H 'content-type: application/json' \
     -d '{"phone":"5511999999999"}'
   # {"code":"ABCD1234"}
   ```

4. Espere o `connection.status` com `open`. `GET /connection` traz a conta em `account`.

Para trocar de número, chame `POST /connection/logout`. O stream mostra o `closed` com
`logged-out` e, em seguida, o QR novo.

### Eventos do stream

| `event` | `data` | Quem recebe |
| --- | --- | --- |
| `connection.status` | `{ status, reason? }` | todos com `connection.read` |
| `connection.qr` | `{ qr, expiresAt? }` | `connection.manage` |
| `connection.pairing-code` | `{ code }` | `connection.manage` |
| `log` | `{ level, time, message, fields }`, com segredos e ids pessoais já censurados | `logs.read` |
| `plugin.status` | `{ name, status: 'loaded' \| 'skipped', reason? }`, a cada reload, disable ou enable | todos com `connection.read` |

A linha de log que carrega o valor do QR ou do código (`fields.event` igual a
`connection.qr.value` ou `connection.pairing-code.value`) só vai a quem tem `connection.manage`.

Filtre por tipo com `?types=log,connection.status`; tipo desconhecido é 400. Na spec, cada item é
um componente (`ConnectionStatusEvent`, `ConnectionQrEvent`, `ConnectionPairingCodeEvent`,
`LogEvent`, `PluginStatusEvent`); o cliente gerado pelo `openapi-typescript` usa esses tipos, já
que ele ignora o `itemSchema`.

### Retomada

Todo evento leva `id`. O `EventSource` reconecta sozinho e manda o último id em `Last-Event-ID`, e
o servidor reenvia só o que veio depois dele, sem repetir. O buffer guarda os últimos 1000 eventos
por sessão. Um cliente fora por mais tempo que isso perde o que girou: releia `GET /connection`.
Depois de um restart do processo, o id antigo não vale, e o stream recomeça pelo estado atual.

O servidor manda `: ping` a cada 15 s, para o proxy não cortar o stream. Um cliente que não lê e
acumula mais de 1000 eventos tem o stream fechado; ele retoma pelo último id. Atrás de nginx,
`X-Accel-Buffering: no` já sai na resposta.

### No browser (cookie)

O `EventSource` não manda header próprio: autentica pelo cookie da sessão. Em outra origem
(`api.cors.origins`), passe `withCredentials`:

```ts
const events = new EventSource('https://bot.exemplo.com/api/events?types=connection.status,connection.qr', {
  withCredentials: true,
});
events.addEventListener('connection.qr', (e) => mostrarQr(JSON.parse(e.data).qr));
events.addEventListener('connection.status', (e) => {
  if (JSON.parse(e.data).status === 'open') esconderQr();
});
```

### Com bearer (servidor ou script)

Com API key, use `fetch` e leia o corpo em stream. Guarde o último `id` para retomar:

```ts
let lastId: string | undefined;
const res = await fetch('http://localhost:3000/api/events?types=log', {
  headers: {
    authorization: `Bearer ${process.env.BRIDGER_KEY}`,
    ...(lastId && { 'last-event-id': lastId }),
  },
});
const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
let buffer = '';
for (;;) {
  const { value, done } = await reader.read();
  if (done) break; // caiu ou o bot parou: reconecte com `last-event-id`
  buffer += value;
  let end: number;
  while ((end = buffer.indexOf('\n\n')) >= 0) {
    const block = buffer.slice(0, end);
    buffer = buffer.slice(end + 2);
    const field = (name: string) =>
      block.split('\n').find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2);
    if (field('id')) lastId = field('id');
    const data = field('data');
    if (data) console.log(field('event'), JSON.parse(data));
  }
}
```

O stream não revalida a credencial depois de aberto: uma sessão revogada recebe eventos até o
stream cair, e a reconexão é recusada.
