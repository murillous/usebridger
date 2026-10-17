import type { LogSignal } from '@usebridger/core';

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
