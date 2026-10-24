// Escopo de correlação (ADR 0120). Cada unidade de trabalho (mensagem, request HTTP, job, boot)
// roda dentro de um `trace`, e o logger o lê daqui ao emitir a linha: o plugin, a fila de saída e
// o scheduler herdam o trace sem repassar nada. Ao contrário do `TenantScope`, o store é do
// módulo: guarda só o id da unidade de trabalho corrente de cada contexto assíncrono, não estado
// do bot, então dois bots no processo não se enxergam, e todo `createLogger` carimba o `trace`
// sem o app configurar nada.

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

const store = new AsyncLocalStorage<string>();

/** Trace do trabalho corrente, ou `undefined` fora de um (timer solto criado antes do boot). */
export function currentTrace(): string | undefined {
  return store.getStore();
}

/** Roda `fn` no trace `trace`; o que ela dispara (promises, timers, filas) herda o id. */
export function runInTrace<R>(trace: string, fn: () => R): R {
  return store.run(trace, fn);
}

/** Trace novo: 32 hex minúsculos, o `trace-id` do W3C Trace Context. */
export function newTraceId(): string {
  return randomUUID().replaceAll('-', '');
}

// Versão 00, `trace-id` e `parent-id` não zerados (o W3C os declara inválidos).
const TRACEPARENT = /^00-(?!0{32}-)([0-9a-f]{32})-(?!0{16}-)[0-9a-f]{16}-[0-9a-f]{2}$/;

/**
 * O `trace-id` de um header `traceparent` válido, ou `undefined`. Header malformado é ignorado,
 * nunca erro: o request segue com um trace gerado.
 */
export function parseTraceparent(header: string | null | undefined): string | undefined {
  return header ? TRACEPARENT.exec(header.trim())?.[1] : undefined;
}

/** O `traceparent` de resposta: o mesmo `trace-id`, com um `span-id` novo deste serviço. */
export function formatTraceparent(trace: string): string {
  return `00-${trace}-${randomUUID().replaceAll('-', '').slice(0, 16)}-01`;
}
