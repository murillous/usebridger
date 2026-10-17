# @usebridger/plugin-dashboard — documentação

Base do dashboard ([ADR 0107](../../../docs/adr/0107-plugins-oficiais-de-metricas-e-dashboard.md)):
autenticação, status, QR, logs e WebSocket sobre o HTTP do core. O app web (telas Login, Visão geral, Logs, Plugins e Config)
vem junto; o desenho está em [design.md](./design.md). Abas de extensão e métricas ainda não estão aqui.

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
`ConnectionStatus` guardado pelo core (`ctx.connectionStatus()`, ADR 0110).

## Config dos plugins

Base dos formulários gerados dos schemas Zod. Exige `createBot({ adminPlugins: ['dashboard'] })`
(`ctx.admin`, ADR 0111); sem isso as duas rotas respondem 503 e o resto do dashboard segue.

| Rota                       | Resposta                                                                 |
| -------------------------- | ------------------------------------------------------------------------ |
| `GET /api/config/:plugin`  | `{ view: { config, messages, sources }, schema }`. `schema` é o JSON Schema da config (`null` se o plugin não declara `config`). Se a config atual está inválida, 200 com `{ view: null, schema, issues: [{ path, message }] }` para o admin corrigir pelo formulário. Plugin desconhecido 404. |
| `PUT /api/config/:plugin`  | Corpo (objeto JSON de overrides, até 64 KiB, senão 413); recusa (403) `Origin` de outro host; sem `Origin`, passa. 200 com o resultado do reload (`{ plugin, dependents, teardownErrors }`); erros de lifecycle saem só como `{ plugin, phase, timedOut, message }` (mensagem truncada em 300), sem stack nem cause. |

Erros do `PUT`: config inválida ou campo `secret` 400 com
`{ "error": "invalid" | "secret", "issues": [{ "path": "campo.aninhado", "message": "..." }] }`
(o `path` liga o erro ao campo do formulário); JSON inválido ou corpo que não é objeto 400;
plugin desconhecido 404; ação no próprio dashboard 409 (sem chamar o core: a config do dashboard vem do arquivo ou do env); outro erro vai ao log e dá 500.

**O override é gravado antes do reload.** Se o reload falhar (409 ou 500), a config válida já ficou salva (a mensagem avisa); corrija e recarregue pelo `reload` de plugins.

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

Exige o acesso admin do core (ADR 0111): ponha `dashboard` em `adminPlugins`, senão as rotas abaixo
respondem 503 e o setup loga um `warn`. Status e logs seguem funcionando.

```ts
createBot({ plugins: [dashboard], adminPlugins: ['dashboard'] });
```

| Rota | Resposta |
| ---- | -------- |
| `GET /api/plugins` | Tabela de boot: array de `{ name, version, origin, status: 'loaded', unregistered? }` ou `{ name, version, origin, status: 'skipped', reason }`, na ordem de carga. `reason` é `{ kind, ... }` como no core; em `setup-failed`, `error` vira `{ plugin, phase, timedOut, message }` (mensagem truncada, nunca o erro cru). |
| `POST /api/plugins/:name/enable`, `/disable`, `/reload` | Sem corpo. 200 `{ plugin, dependents, teardownErrors }` (linhas novas do plugin e dos dependentes; falhas de teardown como `{ plugin, phase, timedOut, message }`). |

Os `POST` exigem o cookie de sessão e `Origin` do mesmo host (senão 403). Nome desconhecido 404;
ação inválida no estado (o próprio dashboard em `disable`/`reload`, plugin ignorado em `reload`,
host parado) 409 com a mensagem; outro erro é logado e responde 500.

## App web

O plugin serve o app React em `GET /` e `GET /*` sob o próprio `basePath`: abra
`http://<host>:<porta>/plugins/dashboard/` (ou `/sessions/<sessão>/plugins/dashboard/`), entre com o
token e navegue pelas telas (rotas por hash: `#/logs`, `#/plugins`, `#/config`).

- **Telas:** Visão geral (status, QR, código de pareamento com Copiar, indicador "ao vivo" que
  vira "Desatualizado" quando o WebSocket cai e reconecta com backoff de 1 a 15 s), Logs (filtro
  por nível e pausar), Plugins (enable/disable/reload com confirmação ao desativar e resultado da
  cascata) e Config (formulário gerado do JSON Schema; secret só como máscara; erros do 400 junto do
  campo). Abaixo de 768 px a navegação vira a barra inferior.
- **Sem caminho fixo:** o plugin injeta `<base href>` no `index.html` e o app chama `api/...`
  relativo a ele; funciona atrás de qualquer prefixo de sessão.
- **Rotas:** o app só atende GET de arquivos e o fallback do SPA (`index.html`); `api/*` que não
  existe responde 404 e nada fora da pasta do app é servido. Os arquivos de `assets/` têm hash e
  cache longo (`immutable`); o resto é `no-cache`. Os estáticos não pedem login (os dados passam
  pela API autenticada).
- **Sem fonte externa:** Onest, Funnel Display e Martian Mono (latin e latin-ext) vão empacotadas em `dist/web/assets` via `@fontsource-variable`, com a pilha do sistema como fallback e `font-display: swap`. Nada vem de CDN.
- **Tema:** segue o `prefers-color-scheme`; a conta (sidebar, ou Mais no celular) permite fixar claro ou escuro, guardado em `localStorage`.
- **Config:** o Salvar devolve os overrides que o formulário não edita (`messages.*`, chaves de `z.record`); com a config atual inválida (`view: null`) ele substitui todos os overrides e pede confirmação.
- **Portão de login:** sem sessão, ou com 401 em qualquer chamada, o app mostra só a tela de login; depois de entrar, volta à rota em que estava. Sair fica na sidebar (desktop) e em Mais (celular).

### Buildar

O fonte está em `web/` (React + Vite, só `devDependencies`). O `pnpm build` do pacote roda o
`tsdown` e depois `vite build --config web/vite.config.ts`, que gera `dist/web/`; a pasta vai no
tarball (`files: ["dist"]`). O plugin lê `dist/web` do pacote, então rode o build antes de abrir o
dashboard a partir do fonte.

## Limites conhecidos

- Depois de um reload, o QR e o código de pareamento não voltam: o snapshot do core só guarda o status de conexão, e eles valem até o próximo evento.
