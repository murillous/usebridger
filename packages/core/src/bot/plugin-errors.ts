import type { EventBus } from '#events/bus.ts';
import type { PluginErrorEvent } from '#events/types.ts';
import * as LOG from '#logger/events.ts';
import type { Logger } from '#logger/types.ts';
import type { PluginLifecycleError } from '#plugin/report.ts';
import { currentTrace } from '#trace/scope.ts';

// `logPluginError` fica solto porque o bus nasce com `onError: logPluginError` antes de o
// reporter existir (o reporter precisa do bus para emitir `plugin.error`).

/** Registra a falha no log do kernel. */
export function logPluginError(log: Logger, event: PluginErrorEvent): void {
  log.event(LOG.pluginFailed, {
    plugin: event.plugin,
    phase: event.phase,
    // `event` é a chave do nome do evento de log (ADR 0118); o do barramento vai em `eventName`.
    eventName: event.event,
    timedOut: event.timedOut,
    err: event.error,
  });
}

export interface PluginErrorReporter {
  /** Falha de handler de plugin: vai ao log e aos observadores de `plugin.error`. */
  readonly report: (event: PluginErrorEvent) => void;
  /** Erros de ciclo de vida do host viram `plugin.error` (o host já os logou). */
  readonly lifecycle: (error: PluginLifecycleError) => void;
}

export function createPluginErrorReporter(deps: {
  /** Getter: o logger nasce no start(). */
  readonly log: () => Logger;
  readonly bus: Pick<EventBus, 'emit'>;
}): PluginErrorReporter {
  return {
    report(event) {
      logPluginError(deps.log(), event);
      // O trace só entra no payload; a linha de log já o carimba sozinha.
      const trace = currentTrace();
      void deps.bus.emit('plugin.error', { ...event, ...(trace ? { trace } : {}) });
    },
    lifecycle(error) {
      const trace = currentTrace();
      const phase = error.phase === 'context' || error.phase === 'setup' ? 'setup' : 'teardown';
      void deps.bus.emit('plugin.error', {
        plugin: error.plugin,
        phase,
        event: null,
        error: error.cause ?? error,
        timedOut: error.timedOut,
        ...(trace ? { trace } : {}),
      });
    },
  };
}
