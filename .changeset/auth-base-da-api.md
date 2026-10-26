---
'@usebridger/core': minor
---

Base da autenticação da API (ADR 0127, #223 parte 1): `api.auth` liga a checagem por operação
(`ApiOperation.permission` / `public`, ator em `input.actor`, 401/403 em problem+json, 403
auditado), permissões e papéis (`CORE_PERMISSIONS`, `rolePermissions`, `canManageRole`), senha com
scrypt, sessões e API keys no storage, e `securitySchemes`/`x-permission` na spec.

Usuários e sessões (parte 2): login por cookie com rate limit, convites de uso único (48 h),
usuários (criar, alterar, desativar, reset de senha), sessões próprias, papéis com último owner
protegido, CSRF em origem cruzada (`X-Bridger-CSRF`), bootstrap por `api.auth.bootstrapToken`,
`bridger owner-invite` e auditoria dos eventos. `ApiOperation.handler` recebe `ip` e pode devolver
`Response`.

Rate limit de login reservado antes do scrypt, com teto global de hashes simultâneos; aceite de
convite sob limite por IP; `api.auth.trustProxy`; cookie com `Path` por sessão do servidor; recusas
de papel e CSRF auditadas como `kernel.auth.denied`; IP no titular da auditoria.

API keys pela API (parte 3): `POST/GET /api/keys` e `DELETE /api/keys/:id` (`keys.manage`, segredo mostrado
uma vez, `createdBy`) e `X-Bridger-On-Behalf-Of` para chaves com `auth.on-behalf-of`, registrado no ator
da auditoria (`AuditActor.onBehalfOf`) e devolvido por `/auth/me`.
