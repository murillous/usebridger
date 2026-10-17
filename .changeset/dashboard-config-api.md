---
"@usebridger/plugin-dashboard": minor
---

API de config dos plugins: `GET`/`PUT /api/config/:plugin` devolvem view (secrets mascarados) e JSON Schema, e gravam overrides com validação e reload; exige `adminPlugins` (M5-4.2).
