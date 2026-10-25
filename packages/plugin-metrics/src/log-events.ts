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
