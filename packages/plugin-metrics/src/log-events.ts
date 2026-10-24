// Eventos de log do plugin (ADR 0118), importados como `import * as LOG`. O nome é contrato com o
// agregador: evento novo é minor; renomear ou remover quebra.

import { defineLogEvent, type LogEvent } from '@usebridger/core';

export const outboundSampleFailed: LogEvent = defineLogEvent({
  name: 'metrics.outbound.sample-failed',
  level: 'error',
  message: 'falha ao amostrar a fila de saída',
});
export const activeSyncFailed: LogEvent = defineLogEvent({
  name: 'metrics.active.sync-failed',
  level: 'error',
  message: 'falha ao somar ativos do dia ao agregado',
});
export const prometheusCollision: LogEvent = defineLogEvent({
  name: 'metrics.prometheus.name-collision',
  level: 'warn',
  message: 'métrica fora do /metrics: nome saneado colide com outro tipo',
});
export const httpMissing: LogEvent = defineLogEvent({
  name: 'metrics.http.missing',
  level: 'info',
  message: 'sem http no bot: GET /metrics desligado',
});
export const flushFailed: LogEvent = defineLogEvent({
  name: 'metrics.flush.failed',
  level: 'error',
  message: 'flush de métricas falhou',
});
export const seriesOverflow: LogEvent = defineLogEvent({
  name: 'metrics.series.overflow',
  level: 'warn',
  message: 'métrica passou do limite de séries; amostras de séries novas descartadas',
});
export const writeFailed: LogEvent = defineLogEvent({
  name: 'metrics.write.failed',
  level: 'error',
  message: 'falha ao gravar métrica; mantida em memória',
});
export const purgeFailed: LogEvent = defineLogEvent({
  name: 'metrics.purge.failed',
  level: 'error',
  message: 'falha ao apagar métricas antigas',
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
