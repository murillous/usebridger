---
'@usebridger/core': minor
---

Novo ponto de entrada `@usebridger/core/zod`, que reexporta o Zod do core (ADR 0095): `import { z } from '@usebridger/core/zod'` declara o schema da config com a mesma cópia que o `definePlugin` tipa, sem o app instalar o `zod`. O `@usebridger/core` segue sem carregar o Zod, então importá-lo continua sem side effect.
