---
'@usebridger/core': minor
---

Base da API HTTP (ADR 0125, 0126, M7-3): `ctx.http.api(operation)` registra operações com schema
Zod sob `/api` (`/sessions/<sessão>/api` fora da `default`), erros em `application/problem+json`
com `traceId`, `GET /openapi.json` (OpenAPI 3.2 via `zod-openapi`), `GET /api/health`, CORS por
allowlist em `BotConfig.api.cors.origins` e `createOpenApiDocument`/`coreApiRoutes` para gerar a
spec sem servidor. `HttpRoutes` ganha o método `api`.
