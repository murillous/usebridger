# ADR 0126 — Operações de plugin na API sob `/api/plugins/<nome>`

**Status:** Aceito (2026-10-25) · Complementa o [ADR 0125](0125-api-http-do-core-e-dashboard-cliente.md)

## Contexto

O ADR 0125 põe a API sob `/api` e deixa o registro de rotas para a M7-3. Falta decidir onde um
plugin pendura as próprias operações e como o contrato do core fica vigiado.

## Decisão

- **`ctx.http.api(operation)`** monta a operação em `/api` + o segmento do dono + `operation.path`:
  `/api/plugins/<nome>/...` no plugin, `/api/transports/<nome>/...` no transport, `/api/...` no core.
  Dois plugins não colidem, e o prefixo diz de quem é o dado. Os recursos declarativos
  (`api.resources`, M7-x) vão ter caminho próprio, sem passar por aqui.
- **Operação** é um objeto com schemas Zod de `params`, `query`, `body` e `response`. A resposta de
  sucesso só descreve a spec; o core não a valida em runtime (custo em toda chamada, e o handler já
  é tipado).
- **Erro** é `application/problem+json` (RFC 9457) com `type: about:blank`, `title`, `status`,
  `detail`, `traceId` e, no 400, `errors` (`in`, `path`, `message`, `code`). O 500 nunca leva
  `detail`. Handler lança `ApiError(status, detail)` para um 4xx esperado.
- **Snapshot da spec do core** em `packages/core/src/api/__snapshots__/openapi.json`, conferido por
  teste (`toMatchFileSnapshot`), que o CI já roda. O teste fixa `info.version` para o release não
  invalidar o arquivo. Quebra de contrato (rota, campo ou enum removido) exige changeset `major`.
- **CORS** por allowlist exata em `BotConfig.api.cors.origins`, só na API. Sem curinga (a auth por
  cookie da M7-4 usa `credentials`). Desligado por padrão.

## Consequências

- A porta continua abrindo só com rota registrada por plugin ou transport; as operações do core
  (`/api/health`, `/openapi.json`) valem enquanto a porta estiver aberta.
- `GET /openapi.json` inclui as operações de todas as sessões do servidor, cada uma no seu prefixo.
