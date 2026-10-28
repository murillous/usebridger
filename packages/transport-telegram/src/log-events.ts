// Eventos de log do transport (ADR 0118), importados como `import * as LOG`. O nome é contrato
// com o agregador: evento novo é minor; renomear ou remover quebra.

import { defineLogEvent, type LogEvent } from '@usebridger/core';

// Comum a todo transport: o mesmo nome no core e nos outros transports.
export const handlerFailed: LogEvent = defineLogEvent({
  name: 'transport.handler.failed',
  level: 'error',
  message: 'handler de evento do transport falhou',
});

export const updateFailed: LogEvent = defineLogEvent({
  name: 'telegram.update.failed',
  level: 'error',
  message: 'falha ao converter update do Telegram; descartado',
});
export const callbackAnswerFailed: LogEvent = defineLogEvent({
  name: 'telegram.callback.answer-failed',
  level: 'warn',
  message: 'falha ao confirmar o clique no Telegram; o botão segue girando até expirar',
});
export const commandsSyncFailed: LogEvent = defineLogEvent({
  name: 'telegram.commands.sync-failed',
  level: 'warn',
  message: 'falha ao registrar o menu de comandos no Telegram; tenta de novo na próxima mudança',
});
export const commandSkipped: LogEvent = defineLogEvent({
  name: 'telegram.commands.skipped',
  level: 'debug',
  message: 'comando fora do menu do Telegram: nome fora de [a-z0-9_]{1,32}',
});
export const stopFailed: LogEvent = defineLogEvent({
  name: 'telegram.stop.failed',
  level: 'warn',
  message: 'falha ao parar o polling do Telegram',
});
