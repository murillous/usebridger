// Usuários e grupos ativos por dia, sem guardar id: o conjunto em memória só tem HMAC dos ids,
// com chave aleatória do dia que nunca é gravada nem logada. Na virada a chave e o conjunto são
// trocados, então o mesmo usuário não é ligável entre dias. Só a contagem sai daqui.

import { createHmac, createSecretKey, type KeyObject, randomBytes } from 'node:crypto';

export interface ActiveTracker {
  record(userId: string, groupId: string | undefined): void;
  /** Tamanho dos conjuntos do dia corrente. */
  sizes(): { users: number; groups: number };
}

interface Day {
  readonly day: string;
  readonly key: KeyObject;
  readonly users: Set<string>;
  readonly groups: Set<string>;
}

export function createActiveTracker(options: { now: () => number }): ActiveTracker {
  const dayOf = (): string => new Date(options.now()).toISOString().slice(0, 10);
  const fresh = (day: string): Day => ({
    day,
    // `KeyObject` uma vez por dia: com `Buffer`, o `createHmac` converte a chave a cada mensagem,
    // o que custava ~13 µs por chamada contra ~2 µs (bench `throughput-metrics`).
    key: createSecretKey(randomBytes(32)),
    users: new Set(),
    groups: new Set(),
  });
  let current = fresh(dayOf());

  // O restart zera o conjunto e o mesmo usuário volta a contar, então restart no meio do dia
  // superestima.
  function roll(): void {
    const day = dayOf();
    if (day !== current.day) current = fresh(day);
  }

  const hash = (id: string): string =>
    createHmac('sha256', current.key).update(id).digest('base64');

  return {
    record(userId, groupId) {
      roll();
      current.users.add(hash(userId));
      if (groupId !== undefined) current.groups.add(hash(groupId));
    },
    sizes() {
      roll();
      return { users: current.users.size, groups: current.groups.size };
    },
  };
}
