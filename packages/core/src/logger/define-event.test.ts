import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { defineLogEvent } from './define-event.ts';
import * as LOG from './events.ts';
import type { LogEvent } from './types.ts';

describe('defineLogEvent', () => {
  it('devolve o evento congelado', () => {
    const event = defineLogEvent({ name: 'plugin.reload.failed', level: 'error', message: 'x' });
    expect(event).toEqual({ name: 'plugin.reload.failed', level: 'error', message: 'x' });
    expect(Object.isFrozen(event)).toBe(true);
  });

  it.each([
    'command.timeout',
    'connection.auth-failed',
    'plugin.boot.report',
    'web2.token.rejected',
  ])('aceita %s', (name) => {
    expect(() =>
      defineLogEvent({ name: name as LogEvent['name'], level: 'info', message: 'x' }),
    ).not.toThrow();
  });

  it.each([
    'command',
    'Command.timeout',
    'command.Timeout',
    'command..timeout',
    'command.timeout.',
    'command_timeout.x',
    'command.-timeout',
    '1command.timeout',
  ])('recusa %s', (name) => {
    expect(() =>
      defineLogEvent({ name: name as LogEvent['name'], level: 'info', message: 'x' }),
    ).toThrow(TypeError);
  });
});

describe('catálogo do core', () => {
  const events = Object.values(LOG) as LogEvent[];

  it('nomes únicos: o nome é a chave de filtro no agregador', () => {
    const names = events.map((event) => event.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('a lista de eventos da doc tem todo evento do core', () => {
    const doc = readFileSync(new URL('../../docs/log-events.md', import.meta.url), 'utf8');
    const missing = events
      .map((event) => event.name)
      .filter((name) => !doc.includes(`\`${name}\``));
    expect(missing).toEqual([]);
  });
});
