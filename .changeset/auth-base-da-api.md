---
'@usebridger/core': minor
---

Base da autenticação da API (ADR 0127, #223 parte 1): `api.auth` liga a checagem por operação
(`ApiOperation.permission` / `public`, ator em `input.actor`, 401/403 em problem+json, 403
auditado), permissões e papéis (`CORE_PERMISSIONS`, `rolePermissions`, `canManageRole`), senha com
scrypt, sessões e API keys no storage, e `securitySchemes`/`x-permission` na spec.
