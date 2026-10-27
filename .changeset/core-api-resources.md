---
'@usebridger/core': minor
---

Ponto de extensão `api.resources` (ADR 0134): o plugin declara um recurso (schema Zod, `list`,
`get`, `create`, `update`, `delete`, ações e permissões) e o core o expõe em
`/api/resources/<plugin>/<id>`, com validação, problem+json, auth e `x-resource` na spec. O
recurso sai da API no disable do plugin. As permissões declaradas pelos plugins (recursos e
`ctx.http.api`) entram nos papéis e no escopo de API key. Novos: `defineResource`, `ApiResource`,
`ResourceAction`, `ResourceActor`, `ResourceCall`; `rolePermissions(role, extra?)`.
