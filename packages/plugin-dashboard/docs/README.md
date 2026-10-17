# @usebridger/plugin-dashboard — documentação

Base do dashboard ([ADR 0107](../../../docs/adr/0107-plugins-oficiais-de-metricas-e-dashboard.md)):
autenticação, status, QR, logs e WebSocket sobre o HTTP do core. Telas, formulários de config e
abas ainda não estão aqui; o desenho está em [design.md](./design.md).

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
| `GET /api/status`   | `{ transport, status, reason?, message?, qr?, pairingCode?, updatedAt }`   |
| `GET /api/logs`     | Array de `{ level, time, message, fields }`, do mais antigo ao mais novo. `?level=<nível>` (`trace`, `debug`, `info`, `warn`, `error`, `fatal`) devolve só esse nível e os acima; nível inválido 400. |
| `GET /api/ws`       | WebSocket (abaixo).                                                       |

`status` é `connecting`, `open` ou `closed`. `qr` e `pairingCode` somem quando a conexão abre.
`closed` traz `reason` e `message` (texto do erro, truncado); o objeto de erro cru nunca sai.

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

## Limites conhecidos

- O `/api/status` não traz o id da sessão: o `ctx` do plugin não o expõe (o caminho base o contém
  fora da `default`).
