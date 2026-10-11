import type { Logger, LogLevel } from '@usebridger/core';
import { describe, expect, it } from 'vitest';
import { baileys } from './index.ts';
import { toBaileysLogger } from './logger.ts';

function recordingLogger(level: LogLevel, lines: string[] = []): Logger & { lines: string[] } {
  const at =
    (method: string) =>
    (message: string): void => {
      lines.push(`${method}:${message}`);
    };
  return {
    lines,
    level,
    trace: at('trace'),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    fatal: at('fatal'),
    child: () => recordingLogger(level, lines),
  };
}

describe('toBaileysLogger', () => {
  it('com piso, descarta as linhas abaixo dele, também nos filhos', () => {
    const log = recordingLogger('info');
    const logger = toBaileysLogger(log, 'warn');
    logger.info({}, 'synced regular to v3');
    logger.child({ class: 'baileys' }).debug('recv frame');
    logger.warn({ attrs: {} }, 'received error in ack');
    logger.child({}).error('falhou');
    expect(log.lines).toEqual(['warn:received error in ack', 'error:falhou']);
  });

  it('o nível que o Baileys lê é o mais alto entre o do bot e o piso', () => {
    expect(toBaileysLogger(recordingLogger('info'), 'warn').level).toBe('warn');
    expect(toBaileysLogger(recordingLogger('error'), 'warn').level).toBe('error');
    expect(toBaileysLogger(recordingLogger('debug')).level).toBe('debug');
  });
});

describe('baileys({ logLevel })', () => {
  it('recusa nível desconhecido', () => {
    expect(() => baileys({ logLevel: 'verbose' as LogLevel })).toThrow(/logLevel/);
    expect(() => baileys({ logLevel: 'debug' })).not.toThrow();
  });
});
