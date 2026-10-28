---
'create-bridger-plugin': patch
---

O projeto gerado traz `@types/node` e `"types": ["node"]` no `tsconfig`: o teste do recurso de
exemplo usa `fetch`, e o `pnpm typecheck` do projeto novo falhava com `Cannot find name 'fetch'`.
