# API HTTP e painéis

Este guia mostra como montar um painel (ou qualquer frontend, backend ou script) sobre a API HTTP
do core: login, conexão do número, config dos plugins, logs, auditoria e os dados que os plugins
expõem. O Bridger não traz painel pronto: cada app desenha o seu, e tudo o que ele precisa sai da
API. A referência rota a rota, com todos os
campos e códigos, fica em [API HTTP](../../packages/core/docs/api.md); aqui está o caminho de quem
constrói.

O exemplo completo de um painel mínimo (login, status e QR, numa página só) está em
[`examples/painel`](../../examples/painel/src/painel.ts).

## Ligar a API

A API sobe com o servidor HTTP do bot. Ligue a autenticação desde o começo: sem ela a API fica
aberta e o `createBot` só aceita escutar em loopback.

```ts
import { createBot, createHttp } from '@usebridger/core';

const bot = createBot({
  transport, storage, plugins,
  http: createHttp({ port: 3000, hostname: '127.0.0.1' }),
  api: {
    auth: { bootstrapToken: appEnv.BRIDGER_BOOTSTRAP_TOKEN }, // 16+ caracteres
    // cors: { origins: ['https://painel.exemplo.com'] }, // só se o painel está em outra origem
  },
});
```

| O quê | Onde |
| --- | --- |
| API da sessão `default` | `/api/...` |
| API de outra sessão (`erp`) | `/sessions/erp/api/...` |
| Spec OpenAPI 3.2 do processo (core e plugins carregados) | `GET /openapi.json` |
| Spec sem subir o bot (build, CI) | `bridger openapi ./src/plugins.ts --out openapi.json` |
| Spec só do core, para consulta | [no site](https://murillous.github.io/usebridger/openapi/) e em [JSON](https://murillous.github.io/usebridger/openapi.json) |

A porta só abre se algum plugin ou o transport registrar rota; um painel servido por plugin (como
o do exemplo) já basta. Detalhes do servidor em [HTTP e WebSocket](../../packages/core/docs/http.md).

A spec é a fonte de verdade do contrato: cada operação traz `x-permission` (o que o ator precisa
ter), `security` e os schemas de entrada e saída. Gere o cliente a partir dela
([abaixo](#cliente-tipado)) em vez de copiar formatos à mão.

## Quem chama a API

Toda operação, com `api.auth`, exige um **ator**. São três jeitos de ser um:

| Quem | Como se autentica | Para quê |
| --- | --- | --- |
| Pessoa no browser | cookie `bridger_session`, depois do `POST /api/auth/login` | o painel |
| Máquina | `Authorization: Bearer brk_...` (API key) | scripts, integrações, CI |
| Backend do seu app em nome de alguém | API key com `auth.on-behalf-of` e header `X-Bridger-On-Behalf-Of` | app com login próprio (BFF) |

### Primeiro acesso

Sem nenhum usuário, o `bootstrapToken` vale como convite do primeiro `owner`. O painel oferece
um formulário que manda o token, nome, e-mail e senha para `POST /api/auth/invites/accept`; a
resposta já traz o cookie da sessão. Depois do primeiro usuário, o token não vale mais, e os
próximos entram por convite (`POST /api/users`, que devolve o token do convite uma vez só).
Perdeu todos os owners? Veja a [recuperação pela CLI](../../packages/core/docs/api.md#recuperação-sem-owner-ativo).

### Login e sessão

```ts
await fetch('/api/auth/login', {
  method: 'POST',
  credentials: 'include',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email, password }),
});
```

O cookie é `HttpOnly`: o JavaScript da página não o lê, e nem precisa. Para saber se há sessão,
chame `GET /api/auth/me`: 200 é logado, 401 é mostrar o login. O login tem limite por IP e por
e-mail (429 com `Retry-After`); mostre a espera em vez de deixar a pessoa insistir.

Com o painel em **outra origem** (`api.cors.origins`), todo `fetch` leva `credentials: 'include'`
e toda escrita (`POST`, `PUT`, `PATCH`, `DELETE`) leva o header `X-Bridger-CSRF` com qualquer
valor. Na mesma origem o header é dispensável; mandar sempre não atrapalha.

### Papéis, permissões e navegação

`GET /api/auth/me` devolve o ator com a lista `permissions` já resolvida. Monte a navegação a
partir dela, não do papel: assim uma aba de plugin aparece para quem ganhou a permissão do plugin,
e uma API key com escopo menor vê menos.

```ts
const me = await (await fetch('/api/auth/me', { credentials: 'include' })).json();
const can = (p: string) => me.permissions.includes(p);

const abas = [
  can('connection.read') && 'Conexão',
  can('plugins.read') && 'Plugins',
  can('config.read') && 'Config',
  can('logs.read') && 'Logs',
  can('audit.read') && 'Auditoria',
  can('users.manage') && 'Usuários',
  can('keys.manage') && 'Chaves',
].filter(Boolean);
```

`owner` e `admin` têm todas as permissões do core e dos plugins carregados; `viewer`, só as
`.read`. O frontend esconder um botão é conforto: quem barra é o core, com 403 em problem+json.

### API keys e BFF

Uma key nasce em `POST /api/keys` com um escopo (lista de permissões) e devolve o segredo
`brk_...` uma única vez. A permissão efetiva é o escopo **∩ o que o criador tem hoje**: rebaixar
quem criou a chave a limita na hora.

Se o seu app já tem login próprio, não replique os usuários no Bridger: o backend do app guarda
uma key com `auth.on-behalf-of` (nunca no browser) e diz em nome de quem chama. O valor vai para
`actor.onBehalfOf` e para a auditoria, sem ampliar o escopo da key.

```sh
curl http://localhost:3000/api/logs \
  -H "Authorization: Bearer $BRIDGER_KEY" -H 'X-Bridger-On-Behalf-Of: user-42'
```

Rotas e regras completas: [Rotas de login e usuários](../../packages/core/docs/api.md#rotas-de-login-e-usuários),
[Criar uma API key](../../packages/core/docs/api.md#criar-uma-api-key) e
[Padrão BFF](../../packages/core/docs/api.md#padrão-bff-x-bridger-on-behalf-of).

## Conexão e tempo real

A tela de conexão usa duas peças: `GET /api/connection` para o estado de agora, e o stream SSE
`GET /api/events` para o que muda.

1. Leia `GET /api/connection`: `status` (`connecting`, `open`, `closed`), `account` quando
   conectado e `pairing` (se o transport pareia por QR ou código).
2. Abra o stream com os tipos que a tela usa. Sem `Last-Event-ID`, ele começa pelo estado atual:
   o último status e, se ainda vale, o QR ou o código.
3. A cada `connection.qr`, desenhe o QR de novo (ele expira e é trocado). Para parear por código
   em vez do QR, `POST /api/connection/pairing-code` com `{ "phone": "5511999999999" }`.
4. No `connection.status` com `open`, releia `GET /api/connection` para mostrar a conta.

```ts
const eventos = new EventSource('/api/events?types=connection.status,connection.qr', {
  withCredentials: true, // necessário em outra origem; inofensivo na mesma
});
eventos.addEventListener('connection.qr', (e) => desenharQr(JSON.parse(e.data).qr));
eventos.addEventListener('connection.status', () => atualizarConexao());
```

O `EventSource` reconecta sozinho e manda o último id em `Last-Event-ID`; o servidor reenvia só o
que veio depois. Depois de um restart do bot, ou de um cliente fora tempo demais, o stream
recomeça pelo estado atual: por isso a tela trata cada evento como "estado novo", não como
incremento. O QR e o código só chegam a quem tem `connection.manage`; quem só lê vê o status.

O mesmo stream entrega `log` (com `logs.read`) e `plugin.status` (a cada reload, disable ou
enable): uma tela de plugins que escuta `plugin.status` não precisa de polling. Com API key, sem
`EventSource`, leia o stream por `fetch`
([exemplo](../../packages/core/docs/api.md#com-bearer-servidor-ou-script)).

## Config de plugins

O core resolve a config de cada plugin campo a campo, nesta ordem
([camadas](../../packages/core/docs/config.md#camadas-e-precedência)):

**env > arquivo (`pluginConfig`) > segredo salvo > override salvo > default do schema**

O painel só escreve nas duas camadas salvas (segredo e override). Um campo que o env ou o arquivo
decidem não muda pelo painel, e a tela precisa deixar isso claro. O `GET` traz tudo para isso:

```sh
curl http://localhost:3000/api/plugins/ia/config -H "Authorization: Bearer $BRIDGER_KEY"
```

| Campo da resposta | Para a tela |
| --- | --- |
| `schema` | JSON Schema da entrada: gere o formulário dele (tipos, enums, limites, `default`) |
| `view.config` | Valores atuais para preencher o formulário; segredos vêm como `********` |
| `view.sources` | De onde vem cada campo (`env`, `file`, `secret`, `override`, `default`): campo `env` ou `file` fica só leitura |
| `view.env` | Nome da variável de cada campo que vem do ambiente, para a tela dizer "definido por `BRIDGER_IA__MODEL`" |
| `view.messages` | Textos do plugin já mesclados, editáveis como os campos |
| `secretsWritable` | `false` sem `BRIDGER_SECRET_KEY` no bot: desabilite a edição de segredos |
| `issues` (com `view: null`) | A config atual é inválida: mostre cada `path` e `message` para corrigir |

Para salvar, mande no `PUT /api/plugins/{name}/config` os **overrides** que a pessoa editou. O
corpo substitui os overrides salvos (`{}` volta tudo ao default):

- Segredo com `********` (ou fora do corpo) mantém o valor salvo; outro valor é segredo novo,
  gravado cifrado e só com `secrets.write`.
- Config que não passa no schema do plugin é 400 com `errors[].path`: marque o campo no formulário.
- Campo decidido pelo env ou pelo arquivo recusa segredo salvo com 409.
- Válida, o plugin recarrega na hora e a resposta traz o mesmo formato do `GET`, já atualizado.

Ligar e desligar um plugin é `POST /api/plugins/{name}/enable` e `/disable` (`plugins.manage`):
desligar leva junto os dependentes, e a resposta lista quem foi afetado. `GET /api/plugins` dá a
lista com `status` e, se `skipped`, o motivo. Toda escrita vai para a auditoria em nome de quem
chamou. Detalhes em [Plugins e config](../../packages/core/docs/api.md#plugins-e-config); como o
autor declara o schema em [Config](config.md).

## Logs, auditoria, usuários e chaves

| Tela | Rotas | Permissão |
| --- | --- | --- |
| Logs recentes | `GET /api/logs` (filtros `level`, `plugin`, `event`, `from`, `to`; cursor `before`) e o stream `GET /api/events?types=log` para o que chega | `logs.read` |
| Auditoria | `GET /api/audit` (cursor nas duas direções), `GET /api/audit/export?format=csv\|json`, `POST /api/audit/verify` | `audit.read` |
| Usuários | `POST`/`GET /api/users`, `GET`/`PATCH /api/users/{id}`, `disable`, `enable`, `reset-password`, encerrar sessões | `users.manage` |
| Minhas sessões | `GET /api/auth/sessions`, `DELETE /api/auth/sessions/{id}`, `POST /api/auth/password` | autenticado |
| Chaves | `POST`/`GET /api/keys`, `DELETE /api/keys/{id}` | `keys.manage` |

Três cuidados de tela:

- **Logs são memória**: as últimas 1000 linhas por bot, zeradas no restart. Para histórico, o
  destino é o agregador do app. Carregue o `GET /api/logs` e emende o stream na frente.
- **Segredo uma vez só**: o convite de `POST /api/users` e o `secret` de `POST /api/keys` não
  voltam em nenhuma outra resposta. Mostre com botão de copiar e avise.
- **Recusas são regras do core**: admin não gerencia owner, o último owner ativo não sai (409),
  e-mail repetido é 409. Mostre o `detail` do problem+json em vez de reescrever a regra no frontend.

Referência: [Logs](../../packages/core/docs/api.md#logs),
[Auditoria](../../packages/core/docs/api.md#auditoria) e
[Login e usuários](../../packages/core/docs/api.md#rotas-de-login-e-usuários).

## Recursos de plugin

Um plugin que quer aparecer no painel declara **recursos** (`api.resources`): o core cria as
rotas de listar, abrir, criar, editar, apagar e as ações, com validação, permissão e spec
([como o plugin declara](../../packages/core/docs/api.md#recursos-de-plugin)). O plugin não
desenha nada: o painel descobre os recursos pela spec e monta a tela a partir do schema.

Cada operação de recurso sai na spec com `x-resource` (`{ plugin, resource, operation, action?,
confirm? }`), `x-permission` e a tag `resources:<plugin>/<id>`:

```ts
const spec = await (await fetch('/openapi.json')).json();
const recursos = new Map<string, { path: string; method: string; op: any }[]>();
for (const [path, item] of Object.entries<any>(spec.paths)) {
  for (const [method, op] of Object.entries<any>(item)) {
    const r = op['x-resource'];
    const permissao = op['x-permission']; // ausente: basta estar logado
    if (!r || (permissao && !can(permissao))) continue;
    const chave = `${r.plugin}/${r.resource}`;
    recursos.set(chave, [...(recursos.get(chave) ?? []), { path, method, op }]);
  }
}
```

| `operation` | Rota sob `/api/resources/<plugin>/<id>` | Na tela |
| --- | --- | --- |
| `list` | `GET`, com `limit`, `cursor` e os campos do `filter` na query | tabela: uma coluna por campo do schema do item; "mais" manda o `cursor` da resposta |
| `get` | `GET /{id}` | detalhe |
| `create` | `POST` | formulário do schema de entrada |
| `update` | `PATCH /{id}` | formulário de edição |
| `delete` | `DELETE /{id}` | botão com confirmação |
| `action` | `POST /{id}/actions/<ação>` | botão por linha; com `confirm`, pergunte antes; com `input`, abra um formulário |

O `x-permission` de cada operação diz se o botão aparece para quem está logado. Entrada inválida
volta 400 com `errors` por campo, como na config. Para um schema do item com nome estável na spec,
o autor do plugin dá `.meta({ id })` a ele, e o cliente gerado ganha o tipo.

## Cliente tipado

Gere os tipos da spec do **seu** app (core mais os plugins que ele carrega) e use um cliente
fino por cima do `fetch`:

```sh
bridger openapi ./src/plugins.ts --out openapi.json
pnpm dlx --package typescript@5 --package openapi-typescript@7.13.0 openapi-typescript openapi.json -o src/api-types.d.ts
```

```ts
import createClient from 'openapi-fetch'; // fixe a versão exata no package.json do frontend
import type { components, paths } from './api-types';

type Problem = components['schemas']['Problem'];

const api = createClient<paths>({ baseUrl: '', credentials: 'include' });

const { data, error } = await api.GET('/api/plugins/{name}/config', {
  params: { path: { name: 'ia' } },
});
if (error) mostrarErro(error); // `error` já vem tipado como problem+json
```

Todo erro sob `/api` é `application/problem+json` (RFC 9457): `status`, `title`, `detail` (o que
mostrar à pessoa), `errors` (400 de validação, um por campo, com `in` e `path`) e `traceId`. Mostre
o `traceId` numa tela de erro: com ele, quem opera o bot acha no log tudo o que aquela chamada fez.
Tabela de status em [Erros](../../packages/core/docs/api.md#erros-problemjson).

Regere os tipos quando atualizar o `@usebridger/core` ou um plugin: mudança que quebra a spec do
core sai como versão `major`, e o compilador aponta onde o painel precisa mudar.

## Exemplo: painel mínimo

[`examples/painel`](../../examples/painel/src/painel.ts) é um plugin que serve uma página HTML em
`/plugins/painel`. A página não usa nada além da API:

1. `GET /api/auth/me`: 401 mostra o login e o formulário de primeiro acesso.
2. `POST /api/auth/login` ou `POST /api/auth/invites/accept` (com o token que o
   [`main.ts`](../../examples/painel/src/main.ts) imprime no terminal) abre a sessão.
3. `GET /api/connection` mostra o estado, e o stream `GET /api/events` desenha cada QR novo até o
   status virar `open`.

```sh
pnpm --filter @usebridger/example-painel start
# Abra http://localhost:3000/plugins/painel
```

O teste do exemplo ([`painel.test.ts`](../../examples/painel/src/painel.test.ts)) faz as mesmas
chamadas contra um bot com transport falso: é um bom modelo para testar o seu painel sem
WhatsApp.

## Em produção

- **Mesma origem** é o caminho simples: o proxy reverso serve o build do painel e encaminha
  `/api`, `/openapi.json` e `/sessions/` para o bot. Sem CORS e sem header de CSRF obrigatório.
- **Outra origem**: liste a origem exata em `api.cors.origins` e use HTTPS (o cookie sai
  `SameSite=None; Secure`).
- **Atrás de proxy**, configure `api.auth.trustProxy` com o número exato de proxies, senão o limite
  de login vale para todos os clientes juntos ([detalhes](../../packages/core/docs/api.md#configurar-a-auth-e-o-cors)).
- O SSE precisa de proxy sem buffer; o core já manda `X-Accel-Buffering: no` para o nginx e um
  `: ping` a cada 15 s.
- O `bootstrapToken` só importa até o primeiro usuário: guarde-o como segredo do deploy e
  remova-o depois, se quiser.
