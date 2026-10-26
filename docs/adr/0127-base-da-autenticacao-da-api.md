# ADR 0127 — Base da autenticação da API: permissões, papéis, senha, sessão e guarda por operação

**Status:** Aceito (2026-10-26) · Complementa o [ADR 0125](0125-api-http-do-core-e-dashboard-cliente.md) e usa a auditoria do [ADR 0122](0122-log-de-auditoria-no-kernel.md)

## Contexto

A #223 (M7-4) põe a autenticação no core. Esta é a primeira de três entregas: a base (modelo,
resolução do ator e guarda por operação). Login, convites, rate limit, CSRF, CRUD de usuários e
chaves e `X-Bridger-On-Behalf-Of` vêm nas seguintes.

## Decisão

- **Permissão** no formato `<área>.<ação>`. A operação a declara em `ApiOperation.permission`, que
  vira `x-permission` na spec. Papéis fixos: `owner` e `admin` com todas as do core, `viewer` só as
  `.read`. A regra "admin não gerencia owner" não é uma permissão: é `canManageRole(ator, alvo)`,
  que as rotas de usuário aplicam.
- **Permissão inválida**: `permission` fora de `<área>.<ação>` lança `BotConfigError` ao registrar
  a operação, em vez de virar 403 para todos.
- **Rota pública** é `public: true`, nunca a ausência de `permission`. Com a auth ligada, operação
  sem `permission` exige apenas estar autenticado, então esquecer o campo não abre a rota.
  `/api/health` é `public`: serve de sonda de orquestrador e só expõe o estado das sessões.
- **Auth opt-in** por `BotConfig.api.auth` (`sessionIdleMs`, aplicado já na resolução do ator; `sessionMaxAgeMs`, aplicado na criação da
  sessão, no login da 2ª entrega). Sem ela a API fica
  aberta como na M7-3, para não quebrar quem já usa. O bootstrap (2ª entrega) é que torna a auth o
  padrão. Vale para as operações do core e para as de plugin (`ctx.http.api`); permissões
  declaradas pelo plugin ficam para o M7-8.
- **Ator** `{ id, kind: 'user' | 'key', name, permissions, role?, onBehalfOf? }`, resolvido do
  cookie `bridger_session` ou de `Authorization: Bearer`. Bearer presente e inválido não cai para o
  cookie. Sessão vencida (inatividade 8 h, absoluta 7 d), revogada ou de usuário desativado, e chave
  revogada, não dão ator. O handler recebe o ator em `input.actor`, e a execução roda com ele como
  titular da auditoria (`runAsAuditSubject`): chave entra como `user` de id `key:<id>`, porque
  `AuditActor` não tem `key`.
- **401** sem ator, **403** sem a permissão, ambos problem+json. Só o 403 gera evento
  (`kernel.auth.denied`, `outcome: denied`, alvo `operation` `<MÉTODO> <caminho>`, `details.permission`).
- **Senha**: `scrypt` (N=2^15, r=8, p=1), sal de 16 bytes por usuário, formato
  `scrypt$N$r$p$sal$chave` com os parâmetros no texto, comparação com `timingSafeEqual`, mínimo de
  10 caracteres. **Segredo opaco** (token de sessão, API key): 256 bits aleatórios, guardado como
  sha256 hex; hash rápido basta porque a entropia já é alta.
- **Storage** no namespace `auth` do kernel: `users` (índice `email`), `sessions` (`hash`, `userId`),
  `apiKeys` (`hash`). A unicidade de e-mail é da camada de cima (convite/CRUD): o storage não tem
  índice unique, então dois cadastros simultâneos do mesmo e-mail podem passar (corrida). Sessão e chave têm `revokedAt` opcional; datas em ISO 8601 UTC.

## Consequências

- `lastSeenAt` é gravado a cada request autenticado por sessão; throttle fica para quando o
  storage reclamar.
- Quem liga `api.auth` sem usuário nem chave recebe 401 em tudo, exceto `/health`, até o bootstrap
  (`api.auth.bootstrapToken`, entregue na parte 2).
- `plugin-dashboard` segue com o token próprio até migrar para a API do core.

## Complemento (parte 2): usuários, sessões e convites

- **Login** `POST /api/auth/login` devolve o cookie `bridger_session` (`HttpOnly; Secure; Path=/`,
  `Max-Age` = vida absoluta). A falha é sempre `401 e-mail ou senha inválidos` (e-mail inexistente,
  senha errada, conta desativada ou sem senha) e a conta inexistente gasta o mesmo scrypt.
- **Rate limit** por IP (do socket, sem confiar em `X-Forwarded-For`) e por e-mail digitado: 5 falhas
  em 15 min bloqueiam por 30 s, dobrando a cada falha (teto 1 h); 429 com `Retry-After`. Em memória
  do processo (`shortcut:` no código); sucesso zera só a chave do e-mail.
- **CSRF**: com `api.cors.origins` e a auth ligada, o cookie de origem permitida sai
  `SameSite=None; Secure` e toda escrita com `Origin` e sem `Authorization` exige `X-Bridger-CSRF`
  (403 sem ele). Sem CORS, `SameSite=Strict` e nada a exigir.
- **Convite**: token `bri_...` de 256 bits, só o hash no storage (`invites`), 48 h, uso único (a
  marcação de uso decide a corrida), um vivo por usuário. Usuário novo nasce sem senha
  (`passwordHash: ''`); o reset zera a senha, encerra as sessões e gera novo convite.
- **Papéis**: as rotas de usuário aplicam `canManageRole` ao papel atual e ao novo; chave sem papel
  conta como admin. O último owner ativo não é desativado nem rebaixado (409).
- **Bootstrap**: `api.auth.bootstrapToken` (16+ caracteres) aceito em `/api/auth/invites/accept`
  com `name` e `email`, só enquanto a coleção `users` está vazia. O core não tem token de dashboard
  (o do `plugin-dashboard` é do plugin), então a config define o do core.
- **Recuperação**: `bridger owner-invite <módulo> --email ...` abre o `storage` exportado pelo módulo
  do app (o storage é do app, como os plugins no `bridger openapi`), recusa se há owner ativo e
  imprime o convite. Não audita.
- A spec offline (`coreApiRoutes()`) descreve as rotas de auth mesmo sem `api.auth`; no servidor só
  montam com ela.
- **Concorrência**: a tentativa de login é contada antes do scrypt (e devolvida no sucesso ou em erro
  nosso), então uma rajada paralela não passa de 5 verificações. No máximo 4 scrypt rodam ao mesmo
  tempo (login, aceite de convite e troca de senha); o excedente leva 429. O aceite de convite valida
  o token antes do scrypt e entra no limite por IP; a troca de senha tem limite por usuário (403 na
  senha atual errada, não 401, porque o usuário já está autenticado).
- **Proxy**: `api.auth.trustProxy` (número de saltos, padrão 0 = IP do socket) lê o IP do
  `X-Forwarded-For` contando de trás para frente. O IP entra no titular da auditoria de todo request
  e em `ip` do `kernel.auth.login.failed`.
- **Cookie** com `Path=<prefixo da sessão>/api`: bots em `/sessions/<nome>` ([ADR 0072](0072-http-do-core.md))
  não sobrescrevem o cookie um do outro. Rotas de conta (`/auth/sessions`, `/auth/password`,
  `/auth/logout`) recusam API key (403); `/auth/me` devolve `onBehalfOf` quando o ator tem.
- **Auditoria de recusas**: o 403 de papel (admin sobre owner) e o de CSRF saem como
  `kernel.auth.denied` com o ator (`details.reason` `role` ou `csrf`).
- **Corridas conhecidas** (aceitas na v1, o storage não tem transação entre documentos): dois
  bootstraps simultâneos podem criar dois owners; dois admins desativando owners ao mesmo tempo
  podem deixar zero owner ativo (a recuperação pela CLI cobre); dois `POST /users` com o mesmo
  e-mail ao mesmo tempo podem duplicar (o login pega o primeiro).
- **`users.manage` equivale a quase tudo**: quem a tem cria admin e, portanto, qualquer permissão do
  core. Dê só a quem seria admin; só o owner cria e gerencia owner.

## Complemento: API keys e `X-Bridger-On-Behalf-Of` (#223, parte 3)

- **Rotas** `POST/GET /api/keys` e `DELETE /api/keys/:id`, permissão `keys.manage`, montadas só com
  `api.auth` (sem auth não haveria quem protegesse); a spec offline as descreve sempre. O segredo (`brk_...`)
  sai só na resposta da criação. O escopo aceita só `CORE_PERMISSIONS` (as de plugin entram no M7-8)
  e nada que o criador não tenha: delegar o que não se tem seria escalar privilégio. Revogar duas
  vezes é idempotente e gera um único evento. Eventos `kernel.key.created` e `kernel.key.revoked`. Conceder além do que se tem é 403 auditado
  como `kernel.auth.denied` (`details.reason` `grant: <permissões>`).
- **`createdBy`**: a chave guarda o id do ator que a criou e a listagem o devolve. A chave **sobrevive**
  ao rebaixamento ou desativação do criador: a revogação é manual, por quem tem `keys.manage`.
- **`X-Bridger-On-Behalf-Of`** é lido pelo guarda, antes da checagem de permissão da operação. Só
  `kind: 'key'` com `auth.on-behalf-of` o usa; sessão de usuário ou chave sem a permissão levam 403
  auditado (`kernel.auth.denied`, `permission: auth.on-behalf-of`). Valor: texto sem caractere de
  controle, 1 a 256 caracteres, senão 400. Não amplia permissão: o escopo é o da chave.
- **Auditoria**: `AuditActor` (`kind: 'user'`) ganha o campo opcional `onBehalfOf`, a menor mudança
  para registrar a pessoa representada no ator do evento, sem criar um `kind` novo.
- O CORS inclui `X-Bridger-On-Behalf-Of` e `X-Bridger-CSRF` no `Access-Control-Allow-Headers` padrão
  do preflight. `/auth/me` devolve `onBehalfOf` quando o ator tem.
