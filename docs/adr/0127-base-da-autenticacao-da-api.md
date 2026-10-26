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
- Quem liga `api.auth` sem usuário nem chave recebe 401 em tudo, exceto `/health`, até o bootstrap (2ª entrega).
- `plugin-dashboard` segue com o token próprio até migrar para a API do core.
