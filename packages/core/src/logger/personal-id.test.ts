import { describe, expect, it } from 'vitest';
import { createLogger, type LogDestination } from './logger.ts';
import { isPersonalId, redactPersonalIds } from './personal-id.ts';

describe('isPersonalId', () => {
  it.each([
    '5511999998888@s.whatsapp.net',
    '120363@g.us',
    '9@lid',
    '5511999998888',
    '+5511999998888',
    '-1001234567',
  ])('reconhece %s', (id) => expect(isPersonalId(id)).toBe(true));

  it.each(['u_abc', 'clima', '12345', 'ok'])('deixa passar %s', (id) =>
    expect(isPersonalId(id)).toBe(false),
  );
});

describe('redactPersonalIds', () => {
  it('troca JIDs e telefones no texto', () => {
    expect(
      redactPersonalIds('de 5511999998888:12@s.whatsapp.net para 120363-45@g.us e 9@lid'),
    ).toBe('de [REDACTED] para [REDACTED] e [REDACTED]');
    expect(redactPersonalIds('ligar para +55 11 e 5511999998888.')).toBe(
      'ligar para +55 11 e [REDACTED].',
    );
  });

  it('não toca número de JSON, versão ou id curto', () => {
    const line =
      '{"time":"2026-10-24T10:00:00.000Z","ms":1730000000000,"n":[1730000000000],"v":"1.2.3"}';
    expect(redactPersonalIds(line)).toBe(line);
  });
});

describe('redação de reserva no logger', () => {
  it('JID e telefone nunca saem, em campo, mensagem, binding e erro', () => {
    const out: string[] = [];
    const destination: LogDestination = { write: (line) => out.push(line) };
    const log = createLogger({ destination });
    log.child({ owner: '5511999998888@s.whatsapp.net' }).warn('falha 5511999998888', {
      chat: '120363@g.us',
      lid: '77@lid',
      err: new Error('x 5511999998888@s.whatsapp.net'),
    });
    const text = out.join('');
    expect(text).not.toMatch(/@s\.whatsapp\.net|@g\.us|@lid|5511999998888/);
    expect(text).toContain('[REDACTED]');
    expect(JSON.parse(out[0] ?? '')).toMatchObject({ chat: '[REDACTED]' });
  });
});

describe('endereço do protocolo Signal (Baileys `addr`)', () => {
  it('troca telefone e LID com sufixo de device', () => {
    expect(redactPersonalIds('addr 5565999998888.0 e 123456789012345_1.0 ok')).toBe(
      'addr [REDACTED] e [REDACTED] ok',
    );
    expect(redactPersonalIds('{"addr":"5565999998888.12"}')).toBe('{"addr":"[REDACTED]"}');
  });

  it('não corta a parte inteira de um decimal longo', () => {
    expect(redactPersonalIds('valor 1234567890123.45678')).toBe('valor 1234567890123.45678');
  });
});
