// Redação dos `details` de um evento de auditoria (ADR 0122): valida que é JSON, mascara as chaves
// conhecidas, remove `content` e deixa o `createRedactor` censurar os segredos do bot.

import { createRedactor } from '#logger/redact.ts';
import type { SecretSource } from '#logger/secrets.ts';
import type { JsonValue } from '#storage/types.ts';

const CENSOR = '[REDACTED]';
// Por sufixo (ADR 0123): chaves derivadas como `accessToken` e `clientSecret` também são segredo.
const SECRET_SUFFIXES = ['password', 'passwd', 'token', 'secret', 'apikey'] as const;
const SECRET_KEYS: ReadonlySet<string> = new Set(['authorization', 'cookie']);

/** Sem diferenciar maiúscula nem separador: `API_KEY`, `api-key` e `apiKey` viram `apikey`. */
function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_-]/g, '');
  return SECRET_KEYS.has(normalized) || SECRET_SUFFIXES.some((s) => normalized.endsWith(s));
}
const MAX_DEPTH = 16;

type Details = { readonly [key: string]: JsonValue };

export type DetailsRedactor = (
  details: { readonly [key: string]: unknown },
  includeContent: boolean,
) => Details;

export function createDetailsRedactor(secrets: SecretSource): DetailsRedactor {
  const redact = createRedactor(secrets);

  const clean = (value: unknown, includeContent: boolean, depth: number): JsonValue => {
    if (depth > MAX_DEPTH) throw new TypeError('audit: details fundo demais (ou circular)');
    if (typeof value === 'string') {
      // NUL não entra em texto de banco (Postgres): o insert falharia sempre e travaria a cadeia.
      if (value.includes('\u0000')) throw new TypeError('audit: details com caractere NUL');
      return value;
    }
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new TypeError('audit: details com número não finito');
      return value;
    }
    if (Array.isArray(value)) return value.map((item) => clean(item, includeContent, depth + 1));
    if (typeof value === 'object') {
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError('audit: details só aceita JSON (objeto simples)');
      }
      const out: Record<string, JsonValue> = {};
      for (const [key, item] of Object.entries(value)) {
        if (item === undefined || (key === 'content' && !includeContent)) continue;
        if (key === '__proto__' || key.includes('\u0000')) {
          throw new TypeError(`audit: details com chave inválida "${key}"`);
        }
        out[key] = isSecretKey(key) ? CENSOR : clean(item, includeContent, depth + 1);
      }
      return out;
    }
    throw new TypeError(`audit: details com valor que não é JSON (${typeof value})`);
  };

  return (details, includeContent) => redact(clean(details, includeContent, 0) as Details);
}
