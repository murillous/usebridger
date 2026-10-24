import { describe, expect, it } from 'vitest';
import { createPseudonymizer } from '#logger/pseudonym.ts';
import { run } from './pseudonym.ts';

const KEY = Buffer.alloc(32, 7);

function exec(argv: string[], env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, { env, out: (t) => out.push(t), err: (t) => err.push(t) });
  return { code, out, err };
}

describe('bridger-pseudonym', () => {
  it('imprime o mesmo pseudônimo que o bot põe nos logs', () => {
    const { pseudonym } = createPseudonymizer(() => KEY);
    const env = { BRIDGER_SECRET_KEY: KEY.toString('base64') };
    expect(exec(['5565999998888@s.whatsapp.net'], env)).toEqual({
      code: 0,
      out: [pseudonym('5565999998888@s.whatsapp.net')],
      err: [],
    });
    expect(exec(['--group', '1@g.us'], env).out).toEqual([pseudonym('1@g.us', 'group')]);
  });

  it('sem chave, chave malformada ou sem id falha com código 1 sem ecoar a chave', () => {
    expect(exec(['x']).code).toBe(1);
    const bad = exec(['x'], { BRIDGER_SECRET_KEY: 'lixo-secreto' });
    expect(bad.code).toBe(1);
    expect(bad.err.join('')).not.toContain('lixo-secreto');
    expect(exec([], { BRIDGER_SECRET_KEY: KEY.toString('base64') }).code).toBe(1);
  });

  it('--help mostra o uso', () => {
    const { code, out } = exec(['--help']);
    expect(code).toBe(0);
    expect(out[0]).toContain('Uso: bridger-pseudonym');
  });
});
