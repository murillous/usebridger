// Eventos de log do plugin (ADR 0118), importados como `import * as LOG`. O nome é contrato com o
// agregador: evento novo é minor; renomear ou remover quebra.

import { defineLogEvent, type LogEvent } from '@usebridger/core';

export const httpMissing: LogEvent = defineLogEvent({
  name: 'metrics.http.missing',
  level: 'info',
  message: 'sem http no bot: GET /metrics desligado',
});
export const seriesOverflow: LogEvent = defineLogEvent({
  name: 'metrics.series.overflow',
  level: 'warn',
  message: 'métrica passou do limite de séries; amostras de séries novas descartadas',
});
export const flushFailed: LogEvent = defineLogEvent({
  name: 'metrics.flush.failed',
  level: 'error',
  message: 'flush de métricas falhou',
});
export const writeFailed: LogEvent = defineLogEvent({
  name: 'metrics.write.failed',
  level: 'error',
  message: 'falha ao gravar métrica; delta mantido para o próximo flush',
});
export const purgeFailed: LogEvent = defineLogEvent({
  name: 'metrics.purge.failed',
  level: 'error',
  message: 'falha ao apagar métricas antigas',
});
export const catalogFailed: LogEvent = defineLogEvent({
  name: 'metrics.catalog.write-failed',
  level: 'error',
  message: 'falha ao gravar o descritor da métrica no catálogo',
});
export const sampleFailed: LogEvent = defineLogEvent({
  name: 'metrics.sample.failed',
  level: 'error',
  message: 'falha ao amostrar as filas para o histórico',
});
export const exporterFailed: LogEvent = defineLogEvent({
  name: 'metrics.exporter.failed',
  level: 'error',
  message: 'exportador de métricas falhou',
});
export const exportersListFailed: LogEvent = defineLogEvent({
  name: 'metrics.exporters.list-failed',
  level: 'error',
  message: 'falha ao listar exportadores de métricas',
});
export const runtimeConfigIgnored: LogEvent = defineLogEvent({
  name: 'metrics.runtime.config-ignored',
  level: 'warn',
  message: 'config do runtime diferente da do primeiro bot; vale a do primeiro para o processo',
});
export const runtimeSampleFailed: LogEvent = defineLogEvent({
  name: 'metrics.runtime.sample-failed',
  level: 'error',
  message: 'falha ao amostrar o runtime do Node para o histórico',
});
export const runtimeScrapeFailed: LogEvent = defineLogEvent({
  name: 'metrics.runtime.scrape-failed',
  level: 'error',
  message: 'falha ao ler a registry do runtime no scrape; o resto do /metrics segue',
});
