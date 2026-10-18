// Cifra dos segredos salvos no storage (ADR 0121): AES-256-GCM do `node:crypto`. O envelope leva
// o `kid` da chave mestra (para saber qual chave decifra, inclusive na rotação) e o AAD
// `<plugin>:<caminho>` autentica o lugar do segredo: um envelope copiado para outro campo ou
// plugin não decifra. Nenhuma mensagem de erro daqui carrega chave, texto claro ou envelope.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { BotConfigError } from './owners.ts';

const KEY_BYTES = 32;
const IV_BYTES = 12;
const KID_BYTES = 6;
const TAG_BYTES = 16;
// Rótulo fixo no hash: o `kid` não é o hash puro da chave, que alguém poderia usar noutro lugar.
const KID_LABEL = 'bridger-secret-key-id-v1';

/** Envelope gravado no storage; os campos binários em base64. */
export type SecretEnvelope = {
  readonly v: 1;
  readonly kid: string;
  readonly iv: string;
  readonly tag: string;
  readonly data: string;
};

/** Chave mestra já validada (32 bytes). */
export type SecretKey = Buffer;

/** `kid` da chave: primeiros bytes do SHA-256 de rótulo + chave (não revela a chave). */
export const keyId = (key: SecretKey): string =>
  createHash('sha256')
    .update(KID_LABEL)
    .update(key)
    .digest()
    .subarray(0, KID_BYTES)
    .toString('base64');

/** Lê uma chave mestra (32 bytes em base64). Lança `BotConfigError` sem ecoar o valor. */
export function parseSecretKey(raw: string, variable: string): SecretKey {
  const text = raw.trim();
  const key = Buffer.from(text, 'base64');
  // Re-codificar pega o lixo que o `Buffer.from` aceitaria calado (fora do alfabeto base64).
  const canonical = key.toString('base64').replace(/=+$/, '');
  if (key.length !== KEY_BYTES || canonical !== text.replace(/=+$/, '')) {
    throw new BotConfigError(
      `${variable} inválida: deve ter 32 bytes em base64 (gere com \`openssl rand -base64 32\`)`,
    );
  }
  return key;
}

export function encrypt(key: SecretKey, aad: string, plaintext: string): SecretEnvelope {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad));
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    v: 1,
    kid: keyId(key),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

/** `true` se o valor tem o formato de envelope (não prova que decifra). */
export function isEnvelope(value: unknown): value is SecretEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    e['v'] === 1 &&
    typeof e['kid'] === 'string' &&
    typeof e['iv'] === 'string' &&
    typeof e['tag'] === 'string' &&
    typeof e['data'] === 'string'
  );
}

/**
 * Decifra com a chave de `kid` igual ao do envelope. Lança se não há essa chave ou se o dado
 * ou o AAD não autenticam.
 */
export function decrypt(keys: readonly SecretKey[], aad: string, envelope: unknown): string {
  if (!isEnvelope(envelope)) throw new Error('envelope malformado');
  const key = keys.find((candidate) => keyId(candidate) === envelope.kid);
  if (!key) throw new Error('nenhuma chave mestra com o kid do envelope');
  const iv = Buffer.from(envelope.iv, 'base64');
  const tag = Buffer.from(envelope.tag, 'base64');
  // Tag curta enfraquece o GCM: exige os tamanhos que o `encrypt` produz.
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('envelope malformado');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.data, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // A mensagem nativa é genérica ("unable to authenticate data"); a nossa diz o que importa.
    throw new Error('envelope não autentica (dado adulterado, chave ou AAD errados)');
  }
}
