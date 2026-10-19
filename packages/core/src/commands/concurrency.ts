import { isThenable } from '#deadline.ts';

/** Teto de execuções simultâneas de um comando (`concurrency`, ADR 0084). */
export interface ConcurrencyLimit {
  /**
   * Roda `task` se houver vaga; senão, espera a vez em ordem de chegada. A vaga só volta quando o
   * resultado de `task` assenta, não quando o prazo estoura: o trabalho que ignora o `signal`
   * continua consumindo CPU. `signal` abortado tira da espera e rejeita com o `reason` dele.
   */
  run(task: () => unknown, signal: AbortSignal): unknown;
}

export function createConcurrencyLimit(max: number): ConcurrencyLimit {
  let active = 0;
  // Em ordem de inserção: o `Set` dá a fila e a remoção de quem desistiu.
  const waiting = new Set<() => void>();

  const release = (): void => {
    const next = waiting.values().next();
    if (next.done) {
      active--;
      return;
    }
    // A vaga passa direto para o próximo, sem voltar a `active`.
    waiting.delete(next.value);
    next.value();
  };

  const start = (task: () => unknown): unknown => {
    let result: unknown;
    try {
      result = task();
    } catch (error) {
      release();
      throw error;
    }
    // Só libera: quem rodou recebe `result` e trata a rejeição.
    if (isThenable(result)) result.then(release, release);
    else release();
    return result;
  };

  return {
    run(task, signal) {
      if (active < max) {
        active++;
        return start(task);
      }
      return new Promise((resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        const onAbort = (): void => {
          waiting.delete(go);
          reject(signal.reason);
        };
        const go = (): void => {
          signal.removeEventListener('abort', onAbort);
          try {
            resolve(start(task));
          } catch (error) {
            reject(error);
          }
        };
        waiting.add(go);
        signal.addEventListener('abort', onAbort, { once: true });
      });
    },
  };
}
