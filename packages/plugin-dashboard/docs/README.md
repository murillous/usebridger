# @usebridger/plugin-dashboard — documentação

Base do dashboard ([ADR 0103](../../../docs/adr/0103-plugins-oficiais-de-metricas-e-dashboard.md)):
autenticação, status, QR, logs e WebSocket sobre o HTTP do core. O app web (telas Login, Visão geral, Métricas, Logs, Plugins e Config)
vem junto; o desenho está em [design.md](./design.md). Abas de plugins: veja abaixo.

## Instalar

Precisa de `http` na config do bot (`createHttp`). Carregue `dashboard` em `plugins` e defina o
token (segredo: mascarado em logs e na config exibida; aceita `BRIDGER_DASHBOARD__TOKEN`).

| Campo             | Padrão  | O que é                                          |
| ----------------- | ------- | ------------------------------------------------ |
| `token`           | -       | Obrigatório, mínimo 16 caracteres. Segredo de acesso. |
| `logBufferSize`   | `500`   | Linhas de log mantidas em memória.               |
| `cookieMaxAgeSec` | `43200` | Validade da sessão (12 h), mínimo 60.            |

## Rotas

Todas sob `/plugins/dashboard` (ou `/sessions/<sessão>/plugins/dashboard` fora da sessão
`default`). Menos o login, exigem o cookie de sessão; sem ele, 401.

| Rota                | Resposta                                                                  |
| ------------------- | ------------------------------------------------------------------------- |
| `POST /api/login`   | Corpo (até 1 KiB, senão 413) `{ "token": "..." }`. 204 + cookie; token errado 401; JSON inválido 400. |
| `POST /api/logout`  | 204; invalida a sessão e expira o cookie.                                 |
| `GET /api/status`   | `{ transport, session, status, reason?, message?, qr?, pairingCode?, updatedAt }` |
| `GET /api/logs`     | Array de `{ level, time, message, fields }`, do mais antigo ao mais novo. `?level=<nível>` (`trace`, `debug`, `info`, `warn`, `error`, `fatal`) devolve só esse nível e os acima; nível inválido 400. |
| `GET /api/ws`       | WebSocket (abaixo).                                                       |

`status` é `connecting`, `open` ou `closed`. `qr` e `pairingCode` somem quando a conexão abre.
`closed` traz `reason` e `message` (texto do erro, truncado); o objeto de erro cru nunca sai.
`session` é o nome da sessão do bot. Depois de um reload do plugin, o status parte do último
`ConnectionStatus` guardado pelo core (`ctx.connectionStatus()`, ADR 0106).
`name` é o nome do bot (`createBot({ name })`, senão o nome do transport) e aparece no cabeçalho
como `name · sessão X`. `connectedSince`, `reconnections` e `qrExpiresAt` (ms epoch) vêm de
`ctx.connectionInfo()` (ADR 0111) e alimentam o card do bot; `qrExpiresAt` só existe se o
transport informar `expiresAt` no `connection.qr` (o Baileys informa).

## Métricas

`GET /api/metrics?days=N` (1 a 90, padrão 7; fora disso 400) lê o serviço `metrics` do
`@usebridger/plugin-metrics`, que é **opcional**: o dashboard só usa o tipo dele e consulta o
serviço a cada pedido (`services.has('metrics')`), então o plugin pode subir depois.

- Sem o plugin: `{ "available": false }` e a tela Métricas explica como instalar; o resto segue.
- Plugin antigo, sem `names`: `{ "available": false, "reason": "version" }` e a tela pede para
  atualizar.
- Com o plugin: `{ available: true, from, to, metrics: [{ name, rows }] }`, uma entrada por métrica
  devolvida por `names(range)` com as linhas de `query` (contador ou histograma, por dia e rótulos).

O serviço é lido a cada pedido, sem `optionalDependsOn`, de propósito: com a dependência declarada,
o reload do `metrics` reiniciaria o dashboard em cascata.

A tela tem painéis fixos das métricas do kernel (`bridger.messages.*`, `bridger.outbound.sent`,
`bridger.active.*`) e a seção "Todas as métricas registradas", que lista tudo o que o serviço
conhece: métrica nova de qualquer plugin aparece ali sem mudar o dashboard. Os gráficos são SVG
com `role="img"`, `aria-label` com os valores por dia e `<title>` por barra; o eixo mostra o primeiro
dia ("12 out") e o último ("hoje") em texto; o valor de cada dia fica no `aria-label` e no `<title>`. Percentil no balde `+Inf` aparece como "> 30.000 ms". A Visão geral
mostra os KPIs de hoje (dia UTC; mensagens, p95, usuários e grupos ativos) quando o serviço existe.

## Config dos plugins

Base dos formulários gerados dos schemas Zod. Exige `createBot({ adminPlugins: ['dashboard'] })`
(`ctx.admin`, ADR 0107); sem isso as duas rotas respondem 503 e o resto do dashboard segue.

| Rota                       | Resposta                                                                 |
| -------------------------- | ------------------------------------------------------------------------ |
| `GET /api/config/:plugin`  | `{ view: { config, messages, sources }, schema, secretsWritable }` (`secretsWritable`: há `BRIDGER_SECRET_KEY`, o core aceita gravar segredo). `schema` é o JSON Schema da config (`null` se o plugin não declara `config`). Se a config atual está inválida, 200 com `{ view: null, schema, secretsWritable, issues: [{ path, message, kind }] }` para o admin corrigir pelo formulário. Plugin desconhecido 404. |
| `PUT /api/config/:plugin`  | Corpo (objeto JSON de overrides, até 64 KiB, senão 413); recusa (403) `Origin` de outro host; sem `Origin`, passa. 200 com o resultado do reload (`{ plugin, dependents, teardownErrors }`); erros de lifecycle saem só como `{ plugin, phase, timedOut, message }` (mensagem truncada em 300), sem stack nem cause. |
| `PUT /api/config/:plugin/secrets/:path` | Grava o segredo cifrado (ADR 0117). `:path` é o caminho pontilhado do campo. Corpo `{ "value": ... }` (até 64 KiB, senão 413). 200 com o resultado do reload; o valor nunca volta. 400: JSON inválido, sem `value`, valor inválido ou sem chave mestra (`{ error, issues }`); 403: `Origin` de outro host; 404: plugin desconhecido; 409: `{ error: "shadowed" }` (env ou arquivo definem o campo), ação no próprio dashboard, ou reload que falhou depois de gravar. |
| `DELETE /api/config/:plugin/secrets/:path` | Remove o segredo (funciona sem chave mestra, também para envelope ilegível). Mesmas respostas, sem corpo. |

Erros do `PUT`: config inválida ou campo `secret` 400 com
`{ "error": "invalid" | "secret", "issues": [{ "path": "campo.aninhado", "message": "..." }] }`
(o `path` liga o erro ao campo do formulário); JSON inválido ou corpo que não é objeto 400;
plugin desconhecido 404; ação no próprio dashboard 409 (sem chamar o core: a config do dashboard vem do arquivo ou do env); outro erro vai ao log e dá 500.

**O override é gravado antes do reload.** Se o reload falhar (409 ou 500), a config válida já ficou salva (a mensagem avisa); corrija e recarregue pelo `reload` de plugins.

**Rótulos, placeholders e datas dos campos.** O rótulo vem do `title` do JSON Schema; sem ele, da
`description` (que então não repete como ajuda); sem ela, do nome da propriedade com inicial
maiúscula. Declare o `title` no schema Zod, junto da descrição: `z.string().meta({ title: 'Chave da API', description: '...' })`
(o core gera o JSON Schema com `toJSONSchema`, que lê o `meta`). `examples[0]` (string ou número,
`.meta({ examples: ['gpt-4o'] })`) vira o placeholder. `z.iso.datetime()` (`format: 'date-time'`)
vira um seletor de data e hora, enviado como ISO em UTC. `#/config/<plugin>` abre a Config já
no plugin (é o destino de "Abrir config" na lista de Plugins).

**Secrets são só leitura no dashboard.** O `GET` os devolve mascarados (o valor real nunca sai) e o
`PUT` recusa qualquer campo `secret`: o valor vem do arquivo (`pluginConfig`) ou do env. A
`view.sources` diz de onde vem cada campo.

## WebSocket

Mensagens do servidor, em JSON (o cliente não precisa enviar nada):

- `{ "type": "snapshot", "status": <status>, "logs": [<log>...] }` ao abrir;
- `{ "type": "status", ...<status> }` a cada mudança de conexão;
- `{ "type": "qr", "qr": "..." }` e `{ "type": "pairing-code", "code": "..." }`;
- `{ "type": "log", "entry": <log> }` a cada linha de log.

O upgrade exige o cookie e, se o pedido trouxer `Origin` (clientes que não são navegador podem omiti-lo), ele tem de ser do mesmo host do
pedido (proteção contra CSWSH). Ao reconectar, o cliente recebe um novo snapshot.

## Segurança

- O cookie `bridger_dashboard` guarda um id de sessão aleatório (32 bytes), nunca o token. A
  sessão fica em memória: reiniciar o bot desloga todos.
- `HttpOnly`, `SameSite=Strict`, `Path` = caminho do plugin. `Secure` é posto quando o pedido veio
  por https, direto ou pelo cabeçalho `X-Forwarded-Proto: https` do proxy.
- O token é comparado em tempo constante. Não há limite de tentativas de login: use um token longo
  e aleatório e ponha um proxy com rate limit na frente se a porta for pública.
- O core não faz TLS: exponha o dashboard só atrás de um proxy HTTPS (nginx, Caddy), que deve repassar
  `Host` e `X-Forwarded-Proto`.
- As linhas de log já saem com os segredos do bot mascarados, mas `fields` pode ter dado de
  negócio: trate o token como acesso ao log.

## Plugins (enable, disable, reload)

Exige o acesso admin do core (ADR 0107): ponha `dashboard` em `adminPlugins`, senão as rotas abaixo
respondem 503 e o setup loga um `warn`. Status e logs seguem funcionando.

```ts
createBot({ plugins: [dashboard], adminPlugins: ['dashboard'] });
```

| Rota | Resposta |
| ---- | -------- |
| `GET /api/plugins` | Tabela de boot: array de `{ name, version, origin, dependsOn?, optionalDependsOn?, status: 'loaded', setupMs?, unregistered?, services?, contributions?, contributionCounts? }` ou `{ name, version, origin, dependsOn?, optionalDependsOn?, status: 'skipped', reason }`, na ordem de carga. `reason` é `{ kind, ... }` como no core; em `setup-failed`, `error` vira `{ plugin, phase, timedOut, message }` (mensagem truncada, nunca o erro cru) e a `reason` ganha `causeMessage`: `Nome: mensagem` do erro lançado no `setup` (até 300 caracteres, sem stack, secrets já censurados pelo core). |
| `GET /api/plugins/boot` | `{ bootedAt }` (ms): horário real do boot, lido do core (`bot.plugins.bootedAt`; não reinicia com o reload do dashboard). Fica numa rota própria porque `GET /api/plugins` é um array. Exige sessão (401 sem ela). |
| `POST /api/plugins/:name/enable`, `/disable`, `/reload` | Sem corpo. 200 `{ plugin, dependents, teardownErrors }` (linhas novas do plugin e dos dependentes; falhas de teardown como `{ plugin, phase, timedOut, message }`). |

Os `POST` exigem o cookie de sessão e `Origin` do mesmo host (senão 403). Nome desconhecido 404;
ação inválida no estado (o próprio dashboard em `disable`/`reload`, plugin ignorado em `reload`,
host parado) 409 com a mensagem; outro erro é logado e responde 500.

## Abas de plugins (`dashboard.tabs`)

Outro plugin ganha uma tela no painel sem mexer no dashboard ([ADR 0104](../../../docs/adr/0104-abas-do-dashboard-por-ponto-de-extensao.md)):
contribui uma `DashboardTab` ao ponto `dashboard.tabs` e o dashboard desenha os widgets. O plugin só
devolve dados; nunca manda HTML, CSS ou script. Os tipos saem de `@usebridger/plugin-dashboard`.

Exemplo, a aba `Lembretes` do plugin `reminders`:

```ts
import { definePlugin } from '@usebridger/core';
import { z } from '@usebridger/core/zod';
import type { DashboardTab } from '@usebridger/plugin-dashboard';

const lembretes: DashboardTab = {
  id: 'lembretes', // [a-z0-9-]{1,40}; a chave pública é "reminders/lembretes"
  title: 'Lembretes',
  widgets: [
    {
      kind: 'stats',
      id: 'resumo',
      load: async () => [
        { label: 'Pendentes', value: 3 },
        { label: 'Atrasados', value: 1, tone: 'warn' }, // tom: 'ok' | 'warn' | 'danger'
      ],
    },
    {
      kind: 'table',
      id: 'lista',
      title: 'Próximos', // qualquer widget aceita title
      columns: [
        { key: 'texto', label: 'Texto' }, // a primeira coluna vira a linha principal no celular
        { key: 'quando', label: 'Quando' },
      ],
      load: async ({ cursor }) => ({ rows: await listar(cursor), cursor: proximo }),
      actions: [
        { id: 'cancelar', label: 'Cancelar', confirm: true, run: async ({ row }) => cancelar(row.id) },
      ],
    },
    { kind: 'series', id: 'envios', title: 'Envios', load: async ({ days }) => porDia(days) },
    {
      kind: 'form',
      id: 'novo',
      title: 'Novo lembrete',
      submitLabel: 'Agendar', // sem ele, "Enviar"
      schema: z.object({ texto: z.string().min(3), minutos: z.number().int().min(1) }),
      submit: async (input) => criar(input),
    },
    { kind: 'text', id: 'ajuda', markdown: 'Use !lembrar 10m texto.' },
  ],
};

export const reminders = definePlugin({
  name: 'reminders',
  version: '1.0.0',
  engine: '<1.0.0',
  after: ['dashboard'], // ou dependsOn, se não roda sem ele
  setup(ctx) {
    ctx.services.contribute('dashboard.tabs', lembretes);
  },
});
```

| Widget   | O plugin entrega                                        | O dashboard desenha                                              |
| -------- | ------------------------------------------------------- | ---------------------------------------------------------------- |
| `stats`  | `load(): StatItem[]` (`label`, `value`, `hint?`, `tone?`) | Cartões; até 3 por linha no celular; `tone` (`ok`, `warn`, `danger`) colore o valor, e tom desconhecido vira neutro |
| `table`  | `columns`, `load({ cursor })`, `actions?`               | Tabela; no celular vira lista (1ª coluna em cima, o resto em mono) |
| `series` | `load({ days })`: `SeriesPoint[]` (`label`, `value`)     | Gráfico de linha com `role="img"` e rótulo; seletor 7/30/90 dias |
| `form`   | `schema` Zod, `submit(input)` e `submitLabel?`          | Formulário do mesmo gerador da Config; campo `secret` é entrada de senha, vazia, enviada no corpo    |
| `text`   | `markdown`                                              | Texto puro: hoje o `markdown` não é renderizado (sem negrito, links ou listas) |

Todo widget aceita `title?`: o dashboard desenha o título sobre o widget e o usa como rótulo da
seção; a `series` o põe dentro do cartão, com "Série" quando falta
([ADR 0114](../../../docs/adr/0114-titulo-tom-e-rotulo-nos-widgets-das-abas.md)).

Rotas (sessão e `Origin` do mesmo host nos `POST`, como no resto):

| Rota                                                    | Faz                                                                                   |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `GET /api/tabs`                                         | Manifesto ordenado por `order` (empate: ordem de carga): `{ key, plugin, id, title, order, widgets }`, sem funções; `form` leva o JSON Schema |
| `GET /api/tabs/:plugin/:tab/:widget`                    | Roda o `load`. `?cursor=` na tabela, `?days=` (1 a 365, padrão 30) na série           |
| `POST /api/tabs/:plugin/:tab/:widget/actions/:action`   | Corpo `{ "row": { "id": "..." } }`; roda o `run`. 204. `row` vem do browser: confie só no `id` |
| `POST /api/tabs/:plugin/:tab/:widget/submit`            | Valida o corpo com o `schema` e roda o `submit`. 204; inválido 400 `{ error: "invalid", issues: [{ path, message }] }` |

- **Chave `<plugin>/<id>`:** o dono vem do registry (`entries()`), não da aba; dois plugins podem
  usar o mesmo `id`. Repetido no mesmo plugin, a primeira vence e sai um `warn` (uma vez).
- **Leitura viva:** cada pedido lê o registry de novo. Reload, disable ou falha de quem contribuiu
  tira a aba na hora: 404, e o app mostra "Esta aba não está mais disponível". O app relê o
  manifesto a cada navegação e a cada reconexão do WebSocket.
- **Validação:** `id` inválido, `kind` desconhecido ou campo faltando ignora a aba (ou só o widget)
  com `warn`; um `kind` novo num dashboard antigo some sem quebrar o resto.
- **Erro por widget:** `load`, `run` ou `submit` que lança responde 500 `erro no widget` (o erro vai
  para o log com o plugin e a chave) e só aquele widget mostra a falha. O `submit` inválido mostra as
  issues do Zod junto dos campos.
- **Manifesto e secret:** o JSON Schema do `form` sai mascarado como o da Config (o `default` de campo
  `secret` vira a máscara). Diferente da Config, o secret do form de aba é digitado e vai no
  `submit`. Um widget cujo manifesto não pode ser montado sai com `warn`; o resto da aba fica.
- **Forma do `load`:** item fora do contrato (`stats` sem `label` string ou `value` string/número;
  linha sem `id` string; ponto sem `label` string ou `value` número) é descartado com `warn`. `order`
  que não é número finito vale 0.
- **Cuidado com o valor de entrada:** `submit` e `refine` não devem pôr o valor recebido em erros ou
  mensagens. O valor de um `secret` iria sem censura ao `log.error` do dashboard, ou voltaria na issue
  do Zod ao browser.
- **Limites:** corpo até 64 KiB (413); resposta cortada em 500 linhas, 1000 pontos e 50 `stats`, com
  `warn`. Não há prazo próprio: trabalho longo é de quem contribui.
- **Navegação:** grupo **Extensões** na sidebar. No celular as abas ficam em **Mais**, e a aba
  aberta traz "← Mais" no topo.

## App web

O plugin serve o app React em `GET /` e `GET /*` sob o próprio `basePath`: abra
`http://<host>:<porta>/plugins/dashboard/` (ou `/sessions/<sessão>/plugins/dashboard/`), entre com o
token e navegue pelas telas (rotas por hash: `#/logs`, `#/plugins`, `#/config`).

- **Telas:** Visão geral (status, QR, código de pareamento com Copiar, indicador "ao vivo" que
  vira "Desatualizado" quando o WebSocket cai e reconecta com backoff de 1 a 15 s), Logs (filtro
  por nível e pausar), Plugins (enable/disable/reload com confirmação ao desativar e resultado da
  cascata; estado carregado/falhou/pulado/desligado, toggle de ativo, busca, painel com a causa do erro
  de setup e, no mobile, filtros e card de problema; contribuições sem contagem e setup sem duração, pois o
  core não expõe nenhum dos dois) e
  Config (lista de plugins ao lado no desktop, `select` abaixo de 768 px; formulário gerado do JSON
  Schema, com lista editável para array de primitivos e pares chave/valor (`control: 'record'`) para `z.record` primitivo;
  secret só como máscara; erros do 400 junto do campo). Abaixo de 768 px a navegação vira a barra inferior.
- **Sem caminho fixo:** o plugin injeta `<base href>` no `index.html` e o app chama `api/...`
  relativo a ele; funciona atrás de qualquer prefixo de sessão.
- **Rotas:** o app só atende GET de arquivos e o fallback do SPA (`index.html`); `api/*` que não
  existe responde 404 e nada fora da pasta do app é servido. Os arquivos de `assets/` têm hash e
  cache longo (`immutable`); o resto é `no-cache`. Os estáticos não pedem login (os dados passam
  pela API autenticada).
- **Sem fonte externa:** Onest, Funnel Display e Martian Mono (latin e latin-ext) vão empacotadas em `dist/web/assets` via `@fontsource-variable`, com a pilha do sistema como fallback e `font-display: swap`. Nada vem de CDN.
- **Tema:** segue o `prefers-color-scheme`; o botão do cabeçalho (topo no celular) alterna claro/escuro, guardado em `localStorage`. Em Mais (celular), a linha Tema volta ao Sistema (`auto`).
- **Cabeçalho e pausa:** `<transport> · sessão <id>`, selo "Ao vivo · atualizado há N s" e "Pausar atualização", que fecha o WebSocket (a tela congela e o selo avisa); retomar reconecta e recebe novo snapshot. O rodapé da sidebar mostra `versions` (core e dashboard) do `/api/status`. O seletor de Sessão lista só a sessão do plugin: a API não expõe as outras.
- **Config:** o Salvar devolve os overrides que o formulário não edita (`messages.*`, chaves de `z.record`); com a config atual inválida (`view: null`) ele substitui todos os overrides e pede confirmação.
- **Portão de login:** sem sessão, ou com 401 em qualquer chamada, o app mostra só a tela de login; depois de entrar, volta à rota em que estava. Sair fica na sidebar (desktop) e em Mais (celular).

### Buildar

O fonte está em `web/` (React + Vite, só `devDependencies`). O `pnpm build` do pacote roda o
`tsdown` e depois `vite build --config web/vite.config.ts`, que gera `dist/web/`; a pasta vai no
tarball (`files: ["dist"]`). O plugin lê `dist/web` do pacote, então rode o build antes de abrir o
dashboard a partir do fonte.

### Testar

Lógica pura do app fica em `web/src/lib` e é testada em Node, como o resto do pacote. Componente
(`web/src/pages/*.test.tsx`) roda no happy-dom com a Testing Library
([ADR 0115](../../../docs/adr/0115-testes-de-componente-do-dashboard-no-happy-dom.md)):

- A primeira linha do arquivo é `// @vitest-environment happy-dom`; os outros testes seguem em Node.
- `afterEach` com `cleanup()`, `vi.unstubAllGlobals()` e `vi.restoreAllMocks()`: o Vitest roda sem
  `globals`, e nem a Testing Library nem o user-event limpam sozinhos (um espião do clipboard
  vaza para o teste seguinte).
- Sem servidor: troque o `fetch` com `vi.stubGlobal` e responda por caminho (o `api` chama
  `fetch('api/<caminho>')`). `Tab.test.tsx` tem o modelo.
- Consulte por papel e nome (`getByRole('button', { name: 'Agendar' })`): o teste também cobre o
  rótulo acessível.
- `#web/*` resolve pelo `imports` do `package.json`, o mesmo mapa do `tsconfig` e do Vite.
- `userEvent.setup()` instala o próprio `navigator.clipboard`: espione o `writeText` com
  `vi.spyOn` depois do `setup()`, não antes.
- O `happy-dom` também está nas `devDependencies` da raiz: sem ele lá, o pnpm cria uma segunda cópia
  do Vitest e o `toContainText` do `@usebridger/testing` some dos tipos em `examples/`.

## Limites conhecidos

- Depois de um reload, o QR e o código de pareamento não voltam: o snapshot do core só guarda o status de conexão, e eles valem até o próximo evento.
- No app web, um override guardado num campo que o arquivo ou o env decidem (`sources` = `file`/`env`) não é reenviado pelo Salvar e some, já que o PUT substitui todos os overrides. Ele não tinha efeito mesmo; se a camada de cima sair, o valor volta ao default.
