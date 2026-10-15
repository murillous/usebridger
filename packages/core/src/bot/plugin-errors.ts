import type { EventBus } from '#events/bus.ts';
import type { PluginErrorEvent } from '#events/types.ts';
import type { Logger } from '#logger/types.ts';
import type { PluginLifecycleError } from '#plugin/report.ts';

// `logPluginError` fica solto porque o bus nasce com `onError: logPluginError` antes de o
// reporter existir (o reporter precisa do bus para emitir `plugin.error`).

/** Registra a falha no log do kernel. */
export function logPluginError(log: Logger, event: PluginErrorEvent): void {
  log.error(`plugin "${event.plugin}" falhou (${event.phase})`, {
    plugin: event.plugin,
    phase: event.phase,
    event: event.event,
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
      void deps.bus.emit('plugin.error', event);
    },
    lifecycle(error) {
      const phase = error.phase === 'context' || error.phase === 'setup' ? 'setup' : 'teardown';
      void deps.bus.emit('plugin.error', {
        plugin: error.plugin,
        phase,
        event: null,
        error: error.cause ?? error,
        timedOut: error.timedOut,
      });
    },
  };
}
