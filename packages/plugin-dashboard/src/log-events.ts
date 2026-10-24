// Eventos de log do plugin (ADR 0118), importados como `import * as LOG`. O nome é contrato com o
// agregador: evento novo é minor; renomear ou remover quebra.

import { defineLogEvent, type LogEvent } from '@usebridger/core';

export const configFailed: LogEvent = defineLogEvent({
  name: 'dashboard.config.failed',
  level: 'error',
  message: 'falha na config do plugin',
});
export const adminMissing: LogEvent = defineLogEvent({
  name: 'dashboard.admin.missing',
  level: 'warn',
  message: 'controle de plugins indisponível: ponha "dashboard" em adminPlugins no createBot',
});
export const pluginActionFailed: LogEvent = defineLogEvent({
  name: 'dashboard.plugin-action.failed',
  level: 'error',
  message: 'falha na ação sobre o plugin',
});
export const tabIgnored: LogEvent = defineLogEvent({
  name: 'dashboard.tab.ignored',
  level: 'warn',
  message: 'aba ignorada',
});
export const tabsManifestFailed: LogEvent = defineLogEvent({
  name: 'dashboard.tabs.manifest-failed',
  level: 'error',
  message: 'falha ao montar o manifesto de abas',
});
export const widgetFailed: LogEvent = defineLogEvent({
  name: 'dashboard.widget.failed',
  level: 'error',
  message: 'falha no widget da aba',
});
export const widgetInvalidItems: LogEvent = defineLogEvent({
  name: 'dashboard.widget.invalid-items',
  level: 'warn',
  message: 'widget devolveu itens fora do contrato; descartados',
});
export const widgetTruncated: LogEvent = defineLogEvent({
  name: 'dashboard.widget.truncated',
  level: 'warn',
  message: 'widget devolveu itens demais; cortado no limite',
});
