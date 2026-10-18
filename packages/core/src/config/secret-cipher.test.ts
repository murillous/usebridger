import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { readSecretKeys } from './env.ts';
import { BotConfigError } from './owners.ts';
import { decrypt, encrypt, keyId, parseSecretKey } from './secret-cipher.ts';

const newKey = () => randomBytes(32);

describe('secret-cipher', () => {
  it('ida e volta, com envelope v1 sem o texto claro', () => {
    const key = newKey();
    const envelope = encrypt(key, 'ai:apiKey', 'sk-0123456789');
    expect(envelope).toMatchObject({ v: 1, kid: keyId(key) });
    expect(JSON.stringify(envelope)).not.toContain('sk-0123456789');
    expect(decrypt([key], 'ai:apiKey', envelope)).toBe('sk-0123456789');
  });

  it('AAD trocado não decifra', () => {
    const key = newKey();
    const envelope = encrypt(key, 'ai:apiKey', 'valor');
    expect(() => decrypt([key], 'ai:outro', envelope)).toThrow('não autentica');
    expect(() => decrypt([key], 'outro:apiKey', envelope)).toThrow('não autentica');
  });

  it('envelope adulterado falha', () => {
    const key = newKey();
    const envelope = encrypt(key, 'a:b', 'valor');
    const flipped = Buffer.from(envelope.data, 'base64');
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    expect(() => decrypt([key], 'a:b', { ...envelope, data: flipped.toString('base64') })).toThrow(
      'não autentica',
    );
    expect(() => decrypt([key], 'a:b', { ...envelope, tag: encrypt(key, 'a:b', 'x').tag })).toThrow(
      'não autentica',
    );
    expect(() => decrypt([key], 'a:b', { v: 2 })).toThrow('malformado');
  });

  it('tag truncada ou IV de tamanho errado não decifra', () => {
    const key = newKey();
    const envelope = encrypt(key, 'a:b', 'valor');
    const short = Buffer.from(envelope.tag, 'base64').subarray(0, 4).toString('base64');
    expect(() => decrypt([key], 'a:b', { ...envelope, tag: short })).toThrow('malformado');
    const iv = Buffer.alloc(8).toString('base64');
    expect(() => decrypt([key], 'a:b', { ...envelope, iv })).toThrow('malformado');
  });

  it('kid desconhecido falha', () => {
    const envelope = encrypt(newKey(), 'a:b', 'valor');
    expect(() => decrypt([newKey()], 'a:b', envelope)).toThrow('kid');
    expect(() => decrypt([], 'a:b', envelope)).toThrow('kid');
  });

  it('o kid é estável e distingue chaves', () => {
    const key = newKey();
    expect(keyId(key)).toBe(keyId(Buffer.from(key)));
    expect(keyId(key)).not.toBe(keyId(newKey()));
  });
});

describe('chave mestra no env', () => {
  const valid = randomBytes(32).toString('base64');

  it('lê a atual e a anterior', () => {
    const keys = readSecretKeys({
      BRIDGER_SECRET_KEY: valid,
      BRIDGER_SECRET_KEY_PREVIOUS: randomBytes(32).toString('base64'),
    });
    expect(keys.current).toHaveLength(32);
    expect(keys.previous).toHaveLength(32);
    expect(readSecretKeys({})).toEqual({ current: undefined, previous: undefined });
  });

  it.each([
    ['curta demais', randomBytes(16).toString('base64')],
    ['longa demais', randomBytes(33).toString('base64')],
    ['fora do base64', `${'!'.repeat(43)}=`],
    ['texto qualquer', 'minha-chave'],
  ])('chave %s falha o boot sem ecoar o valor', (_, bad) => {
    expect(() => readSecretKeys({ BRIDGER_SECRET_KEY: bad })).toThrow(BotConfigError);
    expect(() => parseSecretKey(bad, 'BRIDGER_SECRET_KEY')).toThrow('32 bytes em base64');
    try {
      parseSecretKey(bad, 'BRIDGER_SECRET_KEY');
    } catch (error) {
      expect(String(error)).not.toContain(bad);
    }
  });

  it('chaves atual e anterior iguais falham', () => {
    expect(() =>
      readSecretKeys({ BRIDGER_SECRET_KEY: valid, BRIDGER_SECRET_KEY_PREVIOUS: valid }),
    ).toThrow(BotConfigError);
  });

  it('a anterior sem a atual falha', () => {
    expect(() => readSecretKeys({ BRIDGER_SECRET_KEY_PREVIOUS: valid })).toThrow(BotConfigError);
  });
});
