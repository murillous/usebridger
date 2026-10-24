// Definição de evento de log (ADR 0118). O nome é o contrato com o agregador: filtro e alerta são
// escritos sobre ele, então a forma é validada aqui, uma vez, e não a cada linha.

import type { LogEvent } from './types.ts';

const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+$/;

const LEVELS: ReadonlySet<string> = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);

/**
 * Evento de log com nível e mensagem fixos, para `log.event(evento, campos)`. O nome segue
 * `<área>.<coisa>.<verbo>` em kebab-case (`command.timeout`, `plugin.reload.failed`); fora disso,
 * lança, assim como para nível desconhecido ou mensagem vazia. A mensagem não leva valores: eles vão nos campos.
 */
export function defineLogEvent(event: LogEvent): LogEvent {
  if (!NAME.test(event.name)) {
    throw new TypeError(
      `nome de evento de log inválido: "${event.name}" (use <área>.<coisa>.<verbo> em kebab-case)`,
    );
  }
  // Em JS puro (ou com `as`) o tipo não protege: um nível inválido faria o `log[level]` do
  // logger lançar só na hora de logar, longe da definição.
  if (!LEVELS.has(event.level)) {
    throw new TypeError(`nível de evento de log inválido: "${String(event.level)}"`);
  }
  if (typeof event.message !== 'string' || event.message === '') {
    throw new TypeError(`mensagem de evento de log vazia ou inválida em "${event.name}"`);
  }
  return Object.freeze({ name: event.name, level: event.level, message: event.message });
}
