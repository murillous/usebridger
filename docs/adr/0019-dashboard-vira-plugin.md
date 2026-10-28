# ADR 0019 — Dashboard vira plugin

**Status:** Aceito (2026-10-06) · Decisão **D19** do [plano](../../BRIDGER_PLAN.md#4-decisões) ·
Rotas e autenticação do dashboard substituídas pelo **D125**
([ADR 0125](0125-api-http-do-core-e-dashboard-cliente.md))

## Contexto

O dashboard do LumaBot é o processo pai: spawna o bot como filho e lê sinais como
`[LUMA_QR]` e `[LUMA_STATUS]` parseados do stdout. O protocolo é frágil e acopla o
painel ao processo.

Alternativas consideradas: supervisor separado.

## Decisão

O dashboard vira `@usebridger/plugin-dashboard`, que lê o barramento de eventos e os
schemas de config e expõe a interface pelo HTTP do core
([ADR 0018](0018-http-unico-hono.md)). O protocolo via stdout acaba.

## Consequências

- Plugin pesado que valida a API (eventos, config, HTTP).
- Reiniciar o processo passa a ser responsabilidade do supervisor (PM2/Docker), não do
  dashboard.
- Dashboard central multi-número fica para um projeto comercial futuro.
