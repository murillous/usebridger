---
'@usebridger/core': minor
---

Plugins e config na API (ADR 0131, M7-6): `GET /api/plugins` (`plugins.read`, permissão nova),
`POST /api/plugins/{name}/enable` e `/disable` (`plugins.manage`), `GET /api/plugins/{name}/config`
com os segredos mascarados e o JSON Schema (`config.read`) e `PUT /api/plugins/{name}/config`
(`config.write`; segredo novo exige `secrets.write`, segredo com `********` mantém o valor). As
escritas entram na auditoria em nome do ator da requisição. `ctx.http.api` recusa com
`BotConfigError` operação de plugin em `/config`, `/enable` ou `/disable`, caminhos do core.
