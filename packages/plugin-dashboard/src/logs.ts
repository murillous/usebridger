import type { LogLevel, LogSignal } from '@usebridger/core';

export type LogEntry = Pick<LogSignal, 'level' | 'time' | 'message' | 'fields'>;

/** Buffer em anel: `push` é O(1), pois roda no caminho de todo log do bot. */
export function createLogBuffer(size: number): {
  push(entry: LogEntry): void;
  list(): LogEntry[];
} {
  const items: LogEntry[] = [];
  let head = 0;
  return {
    push(entry) {
      if (items.length < size) items.push(entry);
      else {
        items[head] = entry;
        head = (head + 1) % size;
      }
    },
    list: () => [...items.slice(head), ...items.slice(0, head)],
  };
}

/** Ordem crescente de severidade; o core exporta só o tipo, sem a ordem. `silent` não é nível de linha. */
const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const satisfies LogLevel[];

/** Linhas com nível >= `level`; `undefined` se `level` não for um nível válido. */
export function filterByLevel(entries: LogEntry[], level: string): LogEntry[] | undefined {
  const min = LEVELS.indexOf(level as (typeof LEVELS)[number]);
  if (min < 0) return undefined;
  return entries.filter((e) => LEVELS.indexOf(e.level as (typeof LEVELS)[number]) >= min);
}
