// Limite de tentativas de login por chave (IP e e-mail): 5 falhas em 15 min bloqueiam, e cada falha
// seguinte dobra a espera (ADR 0127, ADR 0128). Conta o e-mail digitado, exista ele ou não, para o
// 429 não revelar se a conta existe. As contagens ficam na coleção `rateLimits` do storage, então
// sobrevivem a restart e valem entre processos que dividem o banco (`increment` é atômico).

import { createMemoryStorage } from '#storage/memory.ts';
import type { PluginStorage } from '#storage/types.ts';
import { hashSecret } from './secret.ts';

export interface LoginLimiterOptions {
  /** Storage do namespace `auth`; sem ele, memória do processo (testes e uso avulso). */
  readonly storage?: PluginStorage;
  readonly now?: () => Date;
  readonly maxFailures?: number;
  readonly windowMs?: number;
  /** Espera após a falha que atinge o limite; dobra a cada falha seguinte. */
  readonly baseWaitMs?: number;
  readonly maxWaitMs?: number;
}

export interface LoginLimiter {
  /** Milissegundos até poder tentar de novo (0 = liberado) para a pior das chaves. */
  wait(keys: readonly string[]): Promise<number>;
  fail(keys: readonly string[]): Promise<void>;
  /** Desfaz uma falha reservada (a tentativa deu certo ou nem chegou a verificar). */
  refund(keys: readonly string[]): Promise<void>;
  reset(key: string): Promise<void>;
}

type LimitDoc = {
  key: string;
  count: number;
  /** Início da janela, em ms desde a época. */
  since: number;
  blockedUntil: number;
};

export function createLoginLimiter(options: LoginLimiterOptions = {}): LoginLimiter {
  const now = options.now ?? (() => new Date());
  const max = options.maxFailures ?? 5;
  const windowMs = options.windowMs ?? 15 * 60_000;
  const baseMs = options.baseWaitMs ?? 30_000;
  const capMs = options.maxWaitMs ?? 60 * 60_000;
  const limits = (
    options.storage ?? createMemoryStorage().forNamespace('auth')
  ).collection<LimitDoc>('rateLimits', { indexes: ['key'] });

  // Varredura de documentos vencidos de chaves que nunca voltam (e-mail digitado uma vez): no
  // máximo uma por janela e por processo, para a coleção não crescer sem limite.
  let lastSweep = 0;
  // A chave vira hash: ela traz e-mail digitado (às vezes uma senha colada) e IP.
  const hashed = (keys: readonly string[]): string[] => keys.map(hashSecret);

  return {
    wait: async (keys) => {
      const at = now().getTime();
      const docs = await limits.find({ where: { key: { in: hashed(keys) } } });
      return Math.max(0, ...docs.map((doc) => doc.blockedUntil - at));
    },
    fail: async (keys) => {
      const at = now().getTime();
      if (at - lastSweep >= windowMs) {
        lastSweep = at;
        await limits.delete({ blockedUntil: { lte: at }, since: { lt: at - windowMs } });
      }
      await Promise.all(
        hashed(keys).map(async (key) => {
          // Janela vencida e sem bloqueio: recomeça a contagem (o documento some e é recriado).
          // Entre o `delete` e o `increment`, outro processo pode incrementar ou apagar o mesmo
          // documento: no pior caso uma falha se perde. Aceito (ADR 0128).
          await limits.delete({ key, blockedUntil: { lte: at }, since: { lt: at - windowMs } });
          await limits.increment({ key }, 'count', 1, {
            insert: { key, count: 0, since: at, blockedUntil: 0 },
          });
          const doc = (await limits.find({ where: { key }, limit: 1 }))[0];
          if (doc !== undefined && doc.count >= max) {
            const blockedUntil = at + Math.min(baseMs * 2 ** (doc.count - max), capMs);
            await limits.update({ key, blockedUntil: { lt: blockedUntil } }, { blockedUntil });
          }
        }),
      );
    },
    refund: async (keys) => {
      await Promise.all(
        hashed(keys).map(async (key) => {
          // Entre processos o par decrementa/limpa não é atômico: no pior caso uma falha se perde.
          // Aceito (ADR 0128).
          await limits.increment({ key, count: { gt: 0 } }, 'count', -1);
          await limits.update({ key, count: { lt: max } }, { blockedUntil: 0 });
        }),
      );
    },
    reset: async (key) => {
      await limits.delete({ key: hashSecret(key) });
    },
  };
}
