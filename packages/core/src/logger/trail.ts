// Trilha de eventos (ADR 0120): os fatos de cada unidade de trabalho, em `info`. `trail` na config
// do bot rebaixa para `debug` ou desliga, sem mexer no nível dos erros.

import { BotConfigError } from '#config/owners.ts';
import type { LogEvent, LogFields, Logger } from './types.ts';

/** `'off'` desliga a trilha; `'debug'` a emite em `debug`, para ligá-la só quando investigando. */
export type TrailMode = 'info' | 'debug' | 'off';

export interface Trail {
  /**
   * A trilha vai sair? Falso com `trail: 'off'` ou com o logger acima do nível da trilha. Quem
   * monta campos (pseudônimo, objeto) pergunta antes: no caminho quente, a trilha desligada não
   * pode custar nada.
   */
  enabled(): boolean;
  /** Emite o evento no nível da trilha. */
  emit(event: LogEvent, fields?: LogFields): void;
}

/** Trilha desligada: o padrão de quem não recebe uma, como nos testes de unidade. */
export const NO_TRAIL: Trail = { enabled: () => false, emit: () => undefined };

// Do mais verboso ao mais severo, como o pino ordena os níveis.
const ORDER: readonly string[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

export function createTrail(mode: TrailMode, log: () => Logger): Trail {
  if (mode === 'off') return NO_TRAIL;
  // `'debug'` é a exceção consciente ao "um nível por evento" do ADR 0118: o operador rebaixa a
  // trilha toda. O nível `silent` (e qualquer um fora da lista) não deixa nada passar.
  const level = mode;
  return {
    enabled: () => {
      const min = ORDER.indexOf(log().level);
      return min >= 0 && min <= ORDER.indexOf(level);
    },
    emit: (event, fields) => log().event(mode === 'info' ? event : { ...event, level }, fields),
  };
}

/** Valida o valor vindo da config (JS puro ou `as`). */
export function assertTrailMode(mode: unknown): asserts mode is TrailMode | undefined {
  if (mode !== undefined && mode !== 'info' && mode !== 'debug' && mode !== 'off') {
    throw new BotConfigError(`trail inválido: "${String(mode)}" (use 'info', 'debug' ou 'off')`);
  }
}
