# Protótipo M7-1 (descartável)

Protótipo da pesquisa em `docs/research/m7-api-dashboard.md` (issue #273). Não entra na `develop`.
Fora do workspace do pnpm: instale em cada pasta com `pnpm install --ignore-workspace`.

```sh
pnpm install --ignore-workspace
node a-manual.ts serve                 # opção A, API em :18787 (spec em /openapi.json)
node b-hono-zod-openapi.ts             # opção B, imprime a spec
node c-zod-openapi.ts                  # opção C, imprime a spec 3.1 e 3.2
node check.mjs http://localhost:18787 a-openapi.json
pnpm dlx --package typescript@5 --package openapi-typescript@7.13.0 openapi-typescript http://localhost:18787/openapi.json -o api-live.d.ts
npx tsc -p . && node client.ts         # cliente openapi-fetch

cd web && pnpm install --ignore-workspace && npx vite   # Refine em :15173, proxy /api para :18787
```
