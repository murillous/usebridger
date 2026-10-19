# ADR 0108 — Tabela de plugins com dependências, serviços e contribuições

**Status:** Aceito (2026-10-17) · Estende **D107** ([ADR 0107](0107-acesso-admin-para-plugins.md)) ·
Usado pelo dashboard (**D104**, [ADR 0104](0104-abas-do-dashboard-por-ponto-de-extensao.md))

## Contexto

O canvas de design da tela Plugins pede as colunas estado, setup, `dependsOn`, serviços e
contribuições. A tabela do core (`PluginReportEntry`, de `ctx.admin.plugins()`) só trazia nome,
versão, origem e estado, então o dashboard não tinha de onde ler o resto (#176).

## Decisão

- `PluginReportEntry` ganha três campos opcionais, só presentes quando há algo, como
  `unregistered`: `dependsOn` (manifesto, nome → faixa; em linhas carregadas e ignoradas),
  `services` (serviços providos no `setup`) e `contributions` (pontos de extensão com
  contribuição do plugin; as duas últimas só em linhas `loaded`).
- Serviços e contribuições são lidos do registry na hora de montar a linha (`host.report()` e os
  resultados de start/reload/disable/enable), por `PluginContextHandle.provided` e
  `ServiceRegistry.describe`: um `provide` depois do `setup` também aparece.
- Mudança aditiva: quem não declara nada tem a mesma linha de antes. Nada muda na tabela de boot
  em texto.

## Consequências

- O dashboard mostra as colunas sem consultar o registry por fora.
- `optionalDependsOn` e `after` não entram: o canvas pede só `dependsOn`.
