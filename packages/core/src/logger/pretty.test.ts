import { describe, expect, it } from 'vitest';
import { createLogger, type LogDestination } from './logger.ts';

function capture(level: 'info' | 'trace' = 'info', secrets?: readonly string[]) {
  const raw: string[] = [];
  const destination: LogDestination = { write: (line) => raw.push(line) };
  const log = createLogger({ format: 'pretty', level, destination, ...(secrets && { secrets }) });
  return { log, raw };
}

const CLOCK = /^\d{2}:\d{2}:\d{2} /;

describe("createLogger({ format: 'pretty' })", () => {
  it('escreve hora, nível, plugin, mensagem e campos chave=valor, sem cor num destino próprio', () => {
    const { log, raw } = capture();
    log.child({ plugin: 'clima' }).info('previsão enviada', { chatId: 'g1', cidade: 'São Paulo' });
    expect(raw).toHaveLength(1);
    const line = raw[0] as string;
    expect(line).toMatch(CLOCK);
    expect(line.slice(9)).toBe('INFO  [clima] previsão enviada chatId=g1 cidade="São Paulo"\n');
    expect(line).not.toContain('\u001b[');
  });

  it('respeita o nível e escreve objetos em JSON compacto', () => {
    const { log, raw } = capture();
    log.debug('não sai');
    log.warn('fila cheia', { pending: 100, chats: ['a', 'b'] });
    expect(raw.map((line) => line.slice(9))).toEqual([
      'WARN  fila cheia pending=100 chats=["a","b"]\n',
    ]);
  });

  it('põe o err com a stack e a causa nas linhas seguintes, recuadas', () => {
    const { log, raw } = capture();
    const cause = new Error('ECONNRESET');
    log.error('falha ao enviar', { err: new Error('envio falhou', { cause }) });
    const [head, ...rest] = (raw[0] as string).trimEnd().split('\n');
    expect(head?.slice(9)).toBe('ERROR falha ao enviar');
    expect(rest[0]).toBe('    Error: envio falhou');
    expect(rest.some((line) => line === '    causa: Error: ECONNRESET')).toBe(true);
    expect(rest.every((line) => line.startsWith('    '))).toBe(true);
  });

  it('põe o Error sob outra chave nas linhas seguintes, com o nome do campo', () => {
    const { log, raw } = capture();
    log.error('aba falhou', { error: new Error('manifesto inválido'), aba: 'grupos' });
    const [head, ...rest] = (raw[0] as string).trimEnd().split('\n');
    expect(head?.slice(9)).toBe('ERROR aba falhou aba=grupos');
    expect(rest[0]).toBe('    error: Error: manifesto inválido');
    expect(rest.length).toBeGreaterThan(1);
    expect(rest.every((line) => line.startsWith('    '))).toBe(true);
  });

  it('censura os segredos igual ao JSON', () => {
    const { log, raw } = capture('info', ['sk-segredo-123']);
    log.info('chamando com sk-segredo-123', { token: 'sk-segredo-123' });
    expect(raw[0]).not.toContain('sk-segredo-123');
    expect(raw[0]?.slice(9)).toBe('INFO  chamando com [REDACTED] token=[REDACTED]\n');
  });
});
