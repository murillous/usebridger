import { readFileSync } from 'node:fs';
import type { LogEvent } from '@usebridger/core';
import { describe, expect, it } from 'vitest';
import * as LOG from './log-events.ts';

describe('catálogo de eventos de log', () => {
  const events = Object.values(LOG) as LogEvent[];

  it('nomes únicos: o nome é a chave de filtro no agregador', () => {
    const names = events.map((event) => event.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('a lista de eventos da doc do core tem todo evento do pacote', () => {
    const doc = readFileSync(new URL('../../core/docs/log-events.md', import.meta.url), 'utf8');
    const missing = events
      .map((event) => event.name)
      .filter((name) => !doc.includes(`\`${name}\``));
    expect(missing).toEqual([]);
  });

  it('transport.handler.failed é igual ao do core: o nome, o nível e a mensagem são contrato', () => {
    // O catálogo do core não é API pública, então o literal do core fica aqui.
    expect(LOG.handlerFailed).toEqual({
      name: 'transport.handler.failed',
      level: 'error',
      message: 'handler de evento do transport falhou',
    });
  });
});
