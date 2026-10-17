// Usuários e grupos ativos por dia, sem guardar id: o conjunto em memória só tem HMAC dos ids,
// com chave aleatória do dia que nunca é gravada nem logada. Na virada a chave e o conjunto são
// trocados, então o mesmo usuário não é ligável entre dias. Só a contagem sai daqui.

import { createHmac, randomBytes } from 'node:crypto';

export interface ActiveTracker {
  record(userId: string, groupId: string | undefined): void;
  /** Entrega ao agregado o que cresceu desde a última chamada (idempotente entre flushes). */
  sync(): void;
  /** Tamanho dos conjuntos do dia corrente. */
  sizes(): { users: number; groups: number };
}

interface Day {
  readonly day: string;
  readonly key: Buffer;
  readonly users: Set<string>;
  readonly groups: Set<string>;
  flushedUsers: number;
  flushedGroups: number;
}

export function createActiveTracker(options: {
  now: () => number;
  /** Soma `value` ao contador do `day`. */
  add: (metric: 'users' | 'groups', value: number, day: string) => void;
}): ActiveTracker {
  const dayOf = (): string => new Date(options.now()).toISOString().slice(0, 10);
  const fresh = (day: string): Day => ({
    day,
    key: randomBytes(32),
    users: new Set(),
    groups: new Set(),
    flushedUsers: 0,
    flushedGroups: 0,
  });
  let current = fresh(dayOf());

  // Soma só o delta: `sync` repetido não conta duas vezes. O restart zera o conjunto e o mesmo
  // usuário volta a contar, então restart no meio do dia superestima.
  function flushDelta(d: Day): void {
    if (d.users.size > d.flushedUsers) options.add('users', d.users.size - d.flushedUsers, d.day);
    if (d.groups.size > d.flushedGroups) {
      options.add('groups', d.groups.size - d.flushedGroups, d.day);
    }
    d.flushedUsers = d.users.size;
    d.flushedGroups = d.groups.size;
  }

  function roll(): void {
    const day = dayOf();
    if (day === current.day) return;
    flushDelta(current); // a contagem do dia que acabou vai para o dia dele
    current = fresh(day);
  }

  const hash = (id: string): string =>
    createHmac('sha256', current.key).update(id).digest('base64');

  return {
    record(userId, groupId) {
      roll();
      current.users.add(hash(userId));
      if (groupId !== undefined) current.groups.add(hash(groupId));
    },
    sync() {
      roll();
      flushDelta(current);
    },
    sizes() {
      roll();
      return { users: current.users.size, groups: current.groups.size };
    },
  };
}
