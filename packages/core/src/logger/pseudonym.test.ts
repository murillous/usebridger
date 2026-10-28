import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createPseudonymizer,
  derivePseudonymKey,
  pseudonymWith,
  withPseudonyms,
} from './pseudonym.ts';
import type { LogFields, Logger } from './types.ts';

const master = randomBytes(32);

describe('pseudonym', () => {
  it('é estável com a mesma chave mestra (entre "restarts") e muda com outra', () => {
    const a = createPseudonymizer(() => master).pseudonym;
    const restarted = createPseudonymizer(() => Buffer.from(master)).pseudonym;
    const other = createPseudonymizer(() => randomBytes(32)).pseudonym;
    expect(restarted('5511999998888@s.whatsapp.net')).toBe(a('5511999998888@s.whatsapp.net'));
    expect(other('5511999998888@s.whatsapp.net')).not.toBe(a('5511999998888@s.whatsapp.net'));
  });

  it('ids diferentes dão pseudônimos diferentes; formato u_/g_ + 22 caracteres base64url', () => {
    const { pseudonym } = createPseudonymizer(() => master);
    expect(pseudonym('a@lid')).not.toBe(pseudonym('b@lid'));
    expect(pseudonym('a@lid')).toMatch(/^u_[\w-]{22}$/);
    expect(pseudonym('1@g.us', 'group')).toMatch(/^g_[\w-]{22}$/);
    expect(pseudonym('1@g.us', 'group').slice(2)).toBe(pseudonym('1@g.us').slice(2));
  });

  it('a chave de pseudônimo não é a chave mestra', () => {
    expect(derivePseudonymKey(master).equals(master)).toBe(false);
    expect(pseudonymWith(master)('x')).not.toBe(pseudonymWith(derivePseudonymKey(master))('x'));
  });

  it('sem chave mestra, a chave é do processo: estável nele, e avisa que é efêmera', () => {
    const p = createPseudonymizer(() => undefined);
    expect(p.ephemeral()).toBe(true);
    expect(p.pseudonym('x')).toBe(p.pseudonym('x'));
    expect(createPseudonymizer(() => master).ephemeral()).toBe(false);
  });
});

describe('withPseudonyms', () => {
  function recording() {
    const lines: LogFields[] = [];
    const make = (bindings: LogFields): Logger => {
      const at = (_message: string, fields?: LogFields): void => {
        lines.push({ ...bindings, ...fields });
      };
      return {
        level: 'info',
        trace: at,
        debug: at,
        info: at,
        warn: at,
        error: at,
        fatal: at,
        event: (event, fields) => at(event.message, { ...fields, event: event.name }),
        child: (more) => make({ ...bindings, ...more }),
      };
    };
    return { lines, log: make({}) };
  }

  it('troca chat e sender em campos e bindings, e deixa o resto', () => {
    const { pseudonym } = createPseudonymizer(() => master);
    const { lines, log } = recording();
    const wrapped = withPseudonyms(log, pseudonym);
    wrapped.child({ chat: '120363@g.us' }).info('x', { sender: '1@lid', n: 1 });
    expect(lines[0]).toEqual({
      chat: pseudonym('120363@g.us', 'group'),
      sender: pseudonym('1@lid'),
      n: 1,
    });
  });

  it('não pseudonimiza de novo um valor que já é pseudônimo (ctx.pseudonym)', () => {
    const { pseudonym } = createPseudonymizer(() => master);
    const { lines, log } = recording();
    const already = pseudonym('1@lid');
    withPseudonyms(log, pseudonym).info('x', { sender: already });
    expect(lines[0]).toEqual({ sender: already });
  });
});
