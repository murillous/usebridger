# @usebridger/plugin-dashboard — documentação

App web oficial do Bridger ([ADR 0103](../../../docs/adr/0103-plugins-oficiais-de-metricas-e-dashboard.md)),
cliente genérico da [API HTTP do core](../../core/docs/api.md)
([ADR 0125](../../../docs/adr/0125-api-http-do-core-e-dashboard-cliente.md)). O plugin só serve os
arquivos do app: não tem rota de dados, auth nem config próprias. Tudo o que a tela mostra vem da
API, com a autenticação e as permissões dela. O desenho está em [design.md](./design.md).

## Instalar

Precisa de `http` na config do bot (`createHttp`). Carregue `dashboard` em `plugins`:

```ts
import { createBot, createHttp } from '@usebridger/core';
import { dashboard } from '@usebridger/plugin-dashboard';

createBot({
  transport,
  storage,
  http: createHttp({ port: 3000 }),
  api: { auth: { bootstrapToken: appEnv.BRIDGER_BOOTSTRAP_TOKEN } },
  plugins: [dashboard],
});
```

Abra `http://<host>:3000/plugins/dashboard/`, ou `/sessions/<sessão>/plugins/dashboard/` fora da
sessão `default`.

- **Com `api.auth`** (o normal): o app pede login por e-mail e senha. No primeiro acesso, use
  "Tenho um convite", marque "Primeiro acesso" e cole o `bootstrapToken` para criar o owner
  ([primeiro acesso](../../core/docs/api.md#primeiro-acesso-bootstrap)).
- **Sem `api.auth`**: a API fica aberta, e o core só a sobe em loopback (ADR 0128). O app entra
  direto, mostra "API sem auth (loopback)" e esconde as telas de conta, usuários e chaves.

## Telas

Rotas por hash. A navegação e os botões somem quando falta a permissão (a mesma do `x-permission`
da spec); a API recusa de qualquer forma.

| Tela | Rota | Permissão | API |
| --- | --- | --- | --- |
| Conexão: status, conta, QR ao vivo, código de pareamento, desvincular | `#/` | `connection.read`; QR, código e logout com `connection.manage` | `GET /connection`, stream `GET /events` |
| Logs: histórico com filtros (nível mínimo, plugin, evento) e linhas novas ao vivo | `#/logs` | `logs.read`; ao vivo também com `connection.read` | `GET /logs`, evento `log` |
| Plugins: estado do boot, ligar e desligar | `#/plugins` | `plugins.read`; ligar e desligar com `plugins.manage` | `GET /plugins`, `POST /plugins/{name}/enable\|disable` |
| Config de um plugin, formulário gerado do JSON Schema | `#/plugins/<nome>` | `config.read`; salvar com `config.write` | `GET` e `PUT /plugins/{name}/config` |
| Métricas: total por dia de uma métrica do catálogo | `#/metricas` | `metrics.read`, com o `plugin-metrics` carregado | `GET /plugins/metrics/catalog` e `/query` |
| Auditoria: eventos com filtros, verificar a cadeia, exportar CSV e JSON | `#/auditoria` | `audit.read` | `GET /audit`, `POST /audit/verify`, `GET /audit/export` |
| Usuários: convidar, papel, desativar, encerrar sessões, resetar senha | `#/usuarios` | `users.manage` | `/users` |
| API keys: criar com escopo e revogar | `#/chaves` | `keys.manage` | `/keys` |
| Minha conta: trocar a senha, minhas sessões | `#/conta` | pessoa logada | `/auth/password`, `/auth/sessions` |
| Recurso de plugin: lista, detalhe, formulários e ações | `#/recursos/<plugin>/<id>` | as do recurso | `/resources/<plugin>/<id>` |

Detalhes que valem para todas:

- **Tempo real:** um `EventSource` só, com os tipos que a pessoa pode receber. Ele exige
  `connection.read` (a permissão do `GET /events`); sem ela, o selo diz "sem tempo real". O selo do cabeçalho
  diz "ao vivo" ou "reconectando"; o navegador reconecta sozinho com `Last-Event-ID`. Plugin que
  sobe ou desce (`plugin.status`) relê a lista de plugins e a spec.
- **Sessão vencida:** um 401 em qualquer chamada volta ao login.
- **Segredo mostrado uma vez:** o convite (link `#/convite?token=...`) e o segredo da API key
  aparecem só na resposta da criação. O token do convite fica no hash, que não vai ao servidor.

### Config

O formulário sai do `schema` do `GET` pelo `@rjsf`, preenchido com o `view.config`. Salvar manda
no `PUT` os overrides que já existiam (inclusive `messages.*`, que não são campos do form) mais o
que mudou; o plugin recarrega com eles.

- **Segredo** vira campo de senha com `********`. Deixar a máscara mantém o valor salvo; outro
  valor grava o segredo cifrado (precisa de `secrets.write` e de `BRIDGER_SECRET_KEY` no bot).
- **Campo do env ou do arquivo** fica só leitura, com a origem como ajuda: o override não teria
  efeito.
- **Campo esvaziado** sai do corpo, e volta o default.
- **Erro 400** aparece junto do campo (`errors[].path`).
- **Config atual inválida** (`view: null`): o form abre vazio com os erros, e salvar substitui
  todos os overrides depois de confirmar.

### Recursos de plugin

Cada recurso que um plugin publica em `api.resources`
([recursos de plugin](../../core/docs/api.md#recursos-de-plugin)) vira uma entrada em "Recursos de
plugins", montada só com a spec (`x-resource` e `x-permission` de cada operação), sem código do
plugin no app:

- **Lista:** uma coluna por campo do topo do schema do item, o `id` primeiro; os campos do
  `filter` viram filtros (enum e boolean como `select`); "Próxima" e "Anterior" seguem o `cursor`.
- **Novo:** formulário do `create.input`.
- **Detalhe** (`Abrir` na linha): o item do `get`, o formulário do `update.input` preenchido com os
  campos que ele aceita, as ações e o Remover. Ação com `input` abre um formulário; `confirm: true`
  pede confirmação antes; o `output` da ação aparece em JSON.

Dê `title` aos campos do schema (`.meta({ title: 'Nome' })`): é o rótulo do formulário.

## Fazer o próprio frontend

O dashboard é um cliente como outro qualquer: tudo o que ele faz, um app próprio faz pela mesma
API. Passos:

1. **Tipos e cliente:** gere da spec e use o `openapi-fetch`
   ([gerar a spec e o cliente](../../core/docs/api.md#gerar-a-spec-e-o-cliente)).
2. **Mesma origem** (servido pelo seu backend ou atrás do mesmo proxy): login em
   `POST /api/auth/login` e `fetch` com `credentials: 'same-origin'`; o cookie `HttpOnly` faz o
   resto.
3. **Outra origem:** ligue `api.cors.origins` e mande `X-Bridger-CSRF` nas escritas
   ([configurar a auth e o CORS](../../core/docs/api.md#configurar-a-auth-e-o-cors)).
4. **Login próprio:** guarde uma API key no seu backend e chame a API em nome da pessoa
   ([padrão BFF](../../core/docs/api.md#padrão-bff-x-bridger-on-behalf-of)).
5. **Tempo real:** `EventSource` em `/api/events?types=...` no browser, ou `fetch` em stream com
   bearer no servidor ([conexão e tempo real](../../core/docs/api.md#conexão-e-tempo-real)).
6. **Permissões:** `GET /api/auth/me` traz as permissões de quem está logado; esconda o que ela não
   pode, como faz o `can()` de `web/src/lib/viewer.ts`.
7. **Recursos de plugin:** leia o `GET /openapi.json` e filtre as operações com `x-resource`
   (`web/src/lib/spec.ts` faz isso em ~100 linhas).

## Migrar do dashboard antigo (0.3)

- **Saiu a config do plugin** (`token`, `logBufferSize`, `cookieMaxAgeSec`): apague o
  `pluginConfig.dashboard` e o `BRIDGER_DASHBOARD__TOKEN`. O acesso é o da API: configure
  `api.auth` e crie o owner pelo bootstrap.
- **Saíram as rotas** sob `/plugins/dashboard/api/*` (login, status, logs, WebSocket, plugins,
  config, abas): use as da API do core.
- **Saiu o `dashboard.tabs`** e os tipos `DashboardTab`, `DashboardWidget` e afins: migre cada aba
  para `api.resources` ([migrar do `dashboard.tabs`](../../core/docs/api.md#migrar-do-dashboardtabs)).
- **Não precisa mais de `adminPlugins: ['dashboard']`:** o controle de plugins e config vem da API.

## App web

O fonte está em `web/` (React 19 + Vite, só `devDependencies`): cliente tipado `openapi-fetch`,
cache e mutações pelo React Query (`@tanstack/react-query`) e formulários pelo `@rjsf`
([ADR 0125](../../../docs/adr/0125-api-http-do-core-e-dashboard-cliente.md)). O Refine headless
previsto no ADR ficou de fora pela condição do próprio ADR: o `@refinedev/core` no npm segue no
`5.0.12`, sem a 5.2.

- **Sem caminho fixo:** o plugin injeta `<base href>` no `index.html`; o app tira dele a base da
  API da sessão (`web/src/lib/endpoints.ts`) e funciona atrás de qualquer prefixo.
- **Estáticos:** só GET de arquivo e o fallback do SPA (`index.html`); nada fora da pasta do app é
  servido. `assets/` tem hash e cache longo (`immutable`); o resto é `no-cache`. Os estáticos não
  pedem login.
- **Sem fonte externa:** Onest, Funnel Display e Martian Mono vão empacotadas via
  `@fontsource-variable`. Nada vem de CDN; o QR é gerado no browser.
- **Tema:** segue o `prefers-color-scheme`; o botão do cabeçalho alterna claro e escuro, guardado
  em `localStorage`.

### Tipos da API

`web/src/lib/api-types.d.ts` é gerado da spec do core versionada
(`packages/core/src/api/__snapshots__/openapi.json`). Mudou a spec, rode:

```sh
pnpm --filter @usebridger/plugin-dashboard gen:api
```

### Buildar

O `pnpm build` do pacote roda o `tsdown` e depois `vite build --config web/vite.config.ts`, que
gera `dist/web/`. O plugin lê `dist/web` do pacote, então rode o build antes de abrir o dashboard a
partir do fonte.

### Testar

Lógica pura em `web/src/lib/*.test.ts` (Node). Componente em `web/src/**/*.test.tsx`, no happy-dom
com a Testing Library ([ADR 0115](../../../docs/adr/0115-testes-de-componente-do-dashboard-no-happy-dom.md)):

- A primeira linha do arquivo é `// @vitest-environment happy-dom`.
- `web/src/test-support.tsx` tem o kit: `useBase()` (o `<base href>` do plugin), `fakeApi({ 'GET
  /api/connection': () => ({ body }) })` (o `fetch` por rota, com as chamadas em `calls`),
  `problem(status, detail)`, `useFakeEvents()` (`FakeEventSource.last.emit(tipo, dado)`), `me()`,
  `spec()` e `renderApp(hash)`.
- `afterEach` com `cleanup()` e `vi.unstubAllGlobals()`. `window.confirm` se troca com
  `vi.stubGlobal('confirm', ...)`.
- Consulte por papel e nome (`getByRole('button', { name: 'Criar' })`).
- `web/src/e2e.test.tsx` é o ponta a ponta: um bot de verdade (transport falso, auth ligada) e o
  app no happy-dom, com cookie real: primeiro acesso, login, QR, log ao vivo e editar a config.
