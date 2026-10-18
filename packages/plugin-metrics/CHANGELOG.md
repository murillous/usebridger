# @usebridger/plugin-metrics

## 0.1.0

### Minor Changes

- 7c142d8: `MetricsService.names(range)` lista as métricas com dados no intervalo (persistidas ou em memória), para quem precisa descobrir métricas de outros plugins, como o dashboard.
- 59476b8: Métricas do kernel embutidas: o plugin observa `message.handled` e `outbound.sent` (mensagens tratadas, latência de tratamento, envios), conta usuários e grupos ativos por dia via HMAC com chave diária descartável (só a contagem é gravada) e expõe `GET /metrics` no formato de texto do Prometheus, com contadores, histogramas e gauges das filas (`ctx.stats()`).
- ed626b8: Novo pacote `@usebridger/plugin-metrics`: o serviço `metrics` (`counter`, `observe`, `query`) com agregação em memória, flush periódico em baldes diários (`Collection.increment`), histograma de 5 ms a 30 s com p50/p95/p99 na consulta, retenção configurável e o ponto de extensão `metrics.exporters` (ADR 0107).

### Patch Changes

- Updated dependencies [d79e8af]
- Updated dependencies [bf58cef]
- Updated dependencies [59f6646]
- Updated dependencies [9ad8550]
- Updated dependencies [740fed1]
- Updated dependencies [f65c4fa]
- Updated dependencies [97642b6]
- Updated dependencies [8232a57]
- Updated dependencies [36a9796]
  - @usebridger/core@0.8.0
