// Senha (scrypt) e segredo opaco (token de sessão, API key). ADR 0127.

import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

export const MIN_PASSWORD_LENGTH = 10;

// Custo do scrypt: N=2^15, r=8 pede ~32 MiB por hash, no limite do padrão do Node; o maxmem dá folga.
const N = 32768;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const MAX_MEM = 128 * 1024 * 1024;

export class WeakPasswordError extends Error {
  override readonly name = 'WeakPasswordError';

  constructor() {
    super(`a senha precisa ter ao menos ${MIN_PASSWORD_LENGTH} caracteres`);
  }
}

function derive(
  password: string,
  salt: Buffer,
  n: number,
  r: number,
  p: number,
  length: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize('NFKC'),
      salt,
      length,
      { N: n, r, p, maxmem: MAX_MEM },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

/** `scrypt$N$r$p$sal$chave` (base64url): os parâmetros viajam no hash, então dá para subir o custo depois. */
export async function hashPassword(password: string): Promise<string> {
  if (password.length < MIN_PASSWORD_LENGTH) throw new WeakPasswordError();
  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(password, salt, N, R, P, KEY_LENGTH);
  return ['scrypt', N, R, P, salt.toString('base64url'), key.toString('base64url')].join('$');
}

/** `false` para senha errada ou hash malformado; a comparação é em tempo constante. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, key] = stored.split('$');
  if (scheme !== 'scrypt' || !(n && r && p && salt && key)) return false;
  const expected = Buffer.from(key, 'base64url');
  try {
    const actual = await derive(
      password,
      Buffer.from(salt, 'base64url'),
      Number(n),
      Number(r),
      Number(p),
      expected.length,
    );
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    // Parâmetros inválidos (N fora de faixa, memória): hash corrompido, a senha não confere.
    return false;
  }
}

/** Segredo aleatório para token de sessão ou API key; só o `hashSecret` dele vai para o storage. */
export function generateSecret(prefix = ''): string {
  return prefix + randomBytes(32).toString('base64url');
}

/** sha256 em hex: o segredo já tem 256 bits de entropia, então hash rápido basta (sem sal). */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}
