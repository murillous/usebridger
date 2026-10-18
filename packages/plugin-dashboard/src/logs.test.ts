import { describe, expect, it } from 'vitest';
import { filterByLevel, type LogEntry } from './logs.ts';

const entry = (level: LogEntry['level']): LogEntry => ({
  level,
  time: 0,
  message: level,
  fields: {},
});
const all = (['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const).map(entry);

describe('filterByLevel', () => {
  it('trace devolve tudo', () => {
    expect(filterByLevel(all, 'trace')).toEqual(all);
  });

  it('debug exclui só trace', () => {
    expect(filterByLevel(all, 'debug')?.map((e) => e.level)).toEqual([
      'debug',
      'info',
      'warn',
      'error',
      'fatal',
    ]);
  });

  it('nível inválido dá undefined', () => {
    expect(filterByLevel(all, 'silent')).toBeUndefined();
    expect(filterByLevel(all, 'x')).toBeUndefined();
  });
});
