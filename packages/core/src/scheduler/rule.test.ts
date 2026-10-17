import { describe, expect, it } from 'vitest';
import type { JsonValue } from '#storage/types.ts';
import { MIN_EVERY_MS, nextOccurrence, normalizeRule, type RecurrenceRule } from './rule.ts';

const iso = (s: string) => Date.parse(s);
const SP = 'America/Sao_Paulo';
const NY = 'America/New_York';

function next(rule: RecurrenceRule, from: string, previous = from): string {
  return new Date(nextOccurrence(rule, iso(previous), iso(from)))
    .toISOString()
    .replace('.000Z', 'Z');
}

describe('normalizeRule', () => {
  it('rejeita o que não é objeto simples', () => {
    for (const bad of [null, 1, 'x', [], new Date()]) {
      expect(() => normalizeRule(bad)).toThrow(TypeError);
    }
  });

  it('rejeita everyMs e time juntos, ou nenhum dos dois', () => {
    expect(() => normalizeRule({ everyMs: 60_000, time: '08:00', timeZone: SP })).toThrow(
      TypeError,
    );
    expect(() => normalizeRule({})).toThrow(TypeError);
  });

  it('valida everyMs', () => {
    for (const bad of [59_999, 90_000.5, Number.NaN, Number.POSITIVE_INFINITY, '60000']) {
      expect(() => normalizeRule({ everyMs: bad })).toThrow(TypeError);
    }
    expect(normalizeRule({ everyMs: MIN_EVERY_MS })).toEqual({ everyMs: MIN_EVERY_MS });
  });

  it('valida time', () => {
    for (const bad of ['8:00', '24:00', '12:60', '08:00:00', '', 800, undefined]) {
      expect(() => normalizeRule({ time: bad, timeZone: SP })).toThrow(TypeError);
    }
    expect(normalizeRule({ time: '23:59', timeZone: SP })).toEqual({ time: '23:59', timeZone: SP });
  });

  it('valida days', () => {
    for (const bad of [[], [7], [-1], [1.5], ['1'], 'x', 1]) {
      expect(() => normalizeRule({ time: '08:00', days: bad, timeZone: SP })).toThrow(TypeError);
    }
  });

  it('exige timeZone válido', () => {
    expect(() => normalizeRule({ time: '08:00' })).toThrow(TypeError);
    expect(() => normalizeRule({ time: '08:00', timeZone: '' })).toThrow(TypeError);
    expect(() => normalizeRule({ time: '08:00', timeZone: 'Marte/Olympus' })).toThrow(TypeError);
  });

  it('devolve cópia canônica', () => {
    expect(normalizeRule({ time: '19:00', days: [3, 1, 3], timeZone: SP, extra: true })).toEqual({
      time: '19:00',
      days: [1, 3],
      timeZone: SP,
    });
    expect(normalizeRule({ everyMs: 120_000, extra: 1 })).toEqual({ everyMs: 120_000 });
  });

  it('é atribuível a JsonValue', () => {
    const rule: JsonValue = normalizeRule({ time: '08:00', timeZone: SP });
    expect(rule).toBeTruthy();
  });
});

describe('nextOccurrence: everyMs', () => {
  it('com previous = now soma um intervalo', () => {
    expect(nextOccurrence({ everyMs: 60_000 }, 5000, 5000)).toBe(65_000);
  });

  it('não deriva e pula disparos perdidos', () => {
    expect(nextOccurrence({ everyMs: 60_000 }, 1000, 1000 + 60_000 * 3 + 5)).toBe(
      1000 + 60_000 * 4,
    );
  });

  it('com now exatamente numa ocorrência devolve a seguinte', () => {
    expect(nextOccurrence({ everyMs: 60_000 }, 1000, 1000 + 120_000)).toBe(1000 + 180_000);
  });

  it('com now antes de previous usa previous', () => {
    expect(nextOccurrence({ everyMs: 60_000 }, 10_000, 0)).toBe(70_000);
  });
});

describe('nextOccurrence: calendário', () => {
  const daily: RecurrenceRule = { time: '08:00', timeZone: SP };

  it('mesmo dia quando ainda não deu a hora', () => {
    expect(next(daily, '2026-06-10T10:59:00Z')).toBe('2026-06-10T11:00:00Z');
  });

  it('estritamente depois: na hora exata vai para o dia seguinte', () => {
    expect(next(daily, '2026-06-10T11:00:00Z')).toBe('2026-06-11T11:00:00Z');
  });

  it('usa previous quando está à frente de now', () => {
    expect(next(daily, '2026-06-10T00:00:00Z', '2026-06-10T11:00:00Z')).toBe(
      '2026-06-11T11:00:00Z',
    );
  });

  it('toda segunda às 19:00 a partir de uma quarta', () => {
    const rule: RecurrenceRule = { time: '19:00', days: [1], timeZone: SP };
    expect(next(rule, '2026-10-14T12:00:00Z')).toBe('2026-10-19T22:00:00Z');
  });

  it('dia da semana é o local, não o UTC', () => {
    const rule: RecurrenceRule = { time: '22:00', days: [0], timeZone: SP };
    // Domingo 22:00 em São Paulo já é segunda 01:00 em UTC.
    expect(next(rule, '2026-10-14T12:00:00Z')).toBe('2026-10-19T01:00:00Z');
  });

  it('fuso de meia hora', () => {
    const rule: RecurrenceRule = { time: '08:00', timeZone: 'Asia/Kolkata' };
    expect(next(rule, '2026-01-01T00:00:00Z')).toBe('2026-01-01T02:30:00Z');
    expect(next(rule, '2026-01-01T02:30:00Z')).toBe('2026-01-02T02:30:00Z');
  });
});

describe('nextOccurrence: horário de verão', () => {
  const eight: RecurrenceRule = { time: '08:00', timeZone: NY };

  it('mantém 08:00 local na primavera (dia de 23 h)', () => {
    expect(next(eight, '2026-03-07T13:00:00Z')).toBe('2026-03-08T12:00:00Z');
    expect(next(eight, '2026-03-08T12:00:00Z')).toBe('2026-03-09T12:00:00Z');
  });

  it('mantém 08:00 local no outono (dia de 25 h)', () => {
    expect(next(eight, '2026-10-31T12:00:00Z')).toBe('2026-11-01T13:00:00Z');
    expect(next(eight, '2026-11-01T13:00:00Z')).toBe('2026-11-02T13:00:00Z');
  });

  it('horário inexistente cai no pulo: 02:30 vira 03:30 EDT', () => {
    const rule: RecurrenceRule = { time: '02:30', timeZone: NY };
    expect(next(rule, '2026-03-08T00:00:00Z')).toBe('2026-03-08T07:30:00Z');
    expect(next(rule, '2026-03-08T07:30:00Z')).toBe('2026-03-09T06:30:00Z');
  });

  it('horário ambíguo dispara só na primeira ocorrência', () => {
    const rule: RecurrenceRule = { time: '01:30', timeZone: NY };
    expect(next(rule, '2026-11-01T00:00:00Z')).toBe('2026-11-01T05:30:00Z');
    expect(next(rule, '2026-11-01T05:30:00Z')).toBe('2026-11-02T06:30:00Z');
  });

  it('hemisfério sul: Sydney em abril e outubro', () => {
    const rule: RecurrenceRule = { time: '08:00', timeZone: 'Australia/Sydney' };
    // Fim do verão (2026-04-05): 08:00 AEDT (+11) = 21:00Z; depois AEST (+10) = 22:00Z (dia de 25 h).
    expect(next(rule, '2026-04-03T00:00:00Z')).toBe('2026-04-03T21:00:00Z');
    expect(next(rule, '2026-04-03T21:00:00Z')).toBe('2026-04-04T22:00:00Z');
    // Início do verão (2026-10-04): 08:00 AEST = 22:00Z; depois AEDT = 21:00Z (dia de 23 h).
    expect(next(rule, '2026-10-02T22:00:00Z')).toBe('2026-10-03T21:00:00Z');
  });
});
