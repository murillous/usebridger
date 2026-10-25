// Titular do trabalho corrente (ADR 0122): o `user` do request HTTP autenticado (#223) ou o
// `contact` do fluxo LGPD (#225). Store do módulo, como o `trace`: guarda só quem está agindo no
// contexto assíncrono corrente, não estado do bot. O plugin não escolhe o ator; só o core (ou o
// app, ao autenticar o request) entra aqui.

import { AsyncLocalStorage } from 'node:async_hooks';
import type { AuditSubject } from './types.ts';

const store = new AsyncLocalStorage<AuditSubject>();

/** Roda `fn` com `subject` como ator das gravações; promises e timers herdam. */
export function runAsAuditSubject<R>(subject: AuditSubject, fn: () => R): R {
  return store.run(subject, fn);
}

export function currentAuditSubject(): AuditSubject | undefined {
  return store.getStore();
}
