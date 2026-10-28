// Mapa reverso do pseudônimo (ADR 0132): o HMAC não volta ao id, então o bot guarda
// `pseudônimo → id` cifrado no storage quando calcula um pseudônimo. Só a rota da API, com
// permissão própria e auditoria, lê o mapa: o log continua sem telefone nem JID.

import type { SecretKeys } from '#config/env.ts';
import { decrypt, encrypt } from '#config/secret-cipher.ts';
import type { KeyValueStore } from '#storage/types.ts';

/** Teto do cache de pseudônimos já gravados no processo; passou, recomeça (regravar é idempotente). */
const SEEN_MAX = 10_000;

export interface PseudonymMap {
  /** Anota o par sem esperar a gravação; uma vez por pseudônimo no processo. Sem chave mestra, nada. */
  remember(pseudonym: string, id: string): void;
  /** Id do pseudônimo; `undefined` se nunca foi visto (ou se o envelope não decifra mais). */
  resolve(pseudonym: string): Promise<string | undefined>;
  /** `false` sem `BRIDGER_SECRET_KEY`: o pseudônimo é efêmero e o mapa não é gravado. */
  readonly enabled: boolean;
}

export interface PseudonymMapOptions {
  readonly kv: () => KeyValueStore;
  /** Lidas no primeiro uso: o bot só vê o ambiente no start. */
  readonly keys: () => SecretKeys;
  /** Gravação que falhou; o par volta a ser tentado no próximo cálculo. */
  readonly onError: (error: unknown) => void;
}

// O AAD amarra o envelope ao pseudônimo: trocar envelopes entre chaves do KV não decifra.
const aad = (pseudonym: string): string => `pseudonym:${pseudonym}`;

export function createPseudonymMap(options: PseudonymMapOptions): PseudonymMap {
  const seen = new Set<string>();
  let keys: SecretKeys | undefined;
  const current = (): SecretKeys => {
    keys ??= options.keys();
    return keys;
  };
  return {
    remember(pseudonym, id) {
      const key = current().current;
      if (key === undefined || seen.has(pseudonym)) return;
      if (seen.size >= SEEN_MAX) seen.clear();
      seen.add(pseudonym);
      let write: Promise<void>;
      try {
        write = options.kv().set(pseudonym, encrypt(key, aad(pseudonym), id));
      } catch (error) {
        write = Promise.reject(error);
      }
      write.catch((error: unknown) => {
        seen.delete(pseudonym);
        options.onError(error);
      });
    },
    async resolve(pseudonym) {
      const { current: key, previous } = current();
      if (key === undefined) return undefined;
      const envelope = await options.kv().get(pseudonym);
      if (envelope === undefined) return undefined;
      try {
        // A anterior decifra o que foi gravado antes da rotação, enquanto ela estiver no ambiente.
        return decrypt(previous ? [key, previous] : [key], aad(pseudonym), envelope);
      } catch {
        // Chave trocada sem a anterior, ou dado adulterado: para quem consulta, é desconhecido.
        return undefined;
      }
    },
    get enabled() {
      return current().current !== undefined;
    },
  };
}
