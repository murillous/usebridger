// Eventos de log do transport (ADR 0118), importados como `import * as LOG`. O nome é contrato
// com o agregador: evento novo é minor; renomear ou remover quebra.

import { defineLogEvent, type LogEvent } from '@usebridger/core';

// Comum a todo transport: o mesmo nome no core e nos outros transports.
export const handlerFailed: LogEvent = defineLogEvent({
  name: 'transport.handler.failed',
  level: 'error',
  message: 'handler de evento do transport falhou',
});

export const tenantMissing: LogEvent = defineLogEvent({
  name: 'web.tenant.missing',
  level: 'debug',
  message: 'conexão recusada sem o claim de tenant',
});
export const tokenRejected: LogEvent = defineLogEvent({
  name: 'web.token.rejected',
  level: 'debug',
  message: 'token recusado',
});
export const tokenVerifyFailed: LogEvent = defineLogEvent({
  name: 'web.token.verify-failed',
  level: 'warn',
  message: 'não deu para verificar o token',
});
export const uploadVerifyFailed: LogEvent = defineLogEvent({
  name: 'web.upload.verify-failed',
  level: 'warn',
  message: 'não deu para verificar o token do upload',
});
