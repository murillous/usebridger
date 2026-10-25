// Retenção e expurgação da auditoria (ADR 0122). O corte é por `at`, mas o que se apaga é um
// prefixo contíguo em `seq` (o relógio pode ter voltado): acha o maior `seq` vencido e apaga até ele.
// Ordem que mantém a cadeia explicada: grava `kernel.audit.purge`, confirma que entrou, só então apaga.

import { performance } from 'node:perf_hooks';
import { BotConfigError } from '#config/owners.ts';
import * as LOG from '#logger/events.ts';
import type { Logger } from '#logger/types.ts';
import type { Collection, JsonObject } from '#storage/types.ts';
import type { Audit } from './audit.ts';
import { PURGE_ACTION } from './verify.ts';

export const DEFAULT_RETENTION_DAYS = 1825;
const DAY_MS = 86_400_000;
const DELETE_BATCH = 1000;
const CONFIRM_ATTEMPTS = 3;

/** `audit.retentionDays` do `createBot`: inteiro positivo. */
export function validateRetentionDays(days: number | undefined): number {
  if (days === undefined) return DEFAULT_RETENTION_DAYS;
  if (!Number.isInteger(days) || days < 1) {
    throw new BotConfigError(`audit.retentionDays deve ser inteiro positivo; recebido ${days}`);
  }
  return days;
}

export interface AuditRetentionDeps {
  readonly audit: Audit;
  readonly collection: () => Collection<JsonObject>;
  readonly retentionDays: number;
  readonly log: () => Logger;
  /** Relógio do corte (injetável); o intervalo de 24 h usa `performance.now()`. */
  readonly now?: () => Date;
}

export interface AuditRetention {
  /** Uma expurgação agora. Nunca lança; devolve quantos eventos apagou. */
  purge(): Promise<number>;
  /**
   * Gatilho (boot, gravação, renovação da trava): expurga se faz 24 h da última passada que
   * terminou bem. Sem timer.
   */
  tick(): void;
  start(): void;
  /** Para a passada em voo no próximo passo; a promessa resolve quando ela termina. */
  stop(): Promise<void>;
}

export function createAuditRetention(deps: AuditRetentionDeps): AuditRetention {
  const now = deps.now ?? (() => new Date());
  let running: Promise<number> | undefined;
  let active = false;
  // Separado de `active`: `purge()` chamado direto vale antes do `start`, mas não depois do `stop`.
  let stopped = false;
  let lastOk: number | undefined;
  let ok = false;

  async function purgeOnce(): Promise<number> {
    const col = deps.collection();
    const cutoff = new Date(now().getTime() - deps.retentionDays * DAY_MS).toISOString();
    const [last] = await col.find({
      where: { at: { lt: cutoff } },
      orderBy: { field: 'seq', direction: 'desc' },
      limit: 1,
    });
    if (last === undefined) {
      ok = true;
      return 0;
    }
    const toSeq = last['seq'] as number;
    const lastHash = last['hash'] as string;
    const [firstRow] = await col.find({ orderBy: 'seq', limit: 1 });
    const fromSeq = firstRow?.['seq'] as number;
    const count = toSeq - fromSeq + 1;
    if (stopped) return 0;

    deps.audit.record({
      action: PURGE_ACTION,
      actor: { kind: 'system' },
      details: { fromSeq, toSeq, count, lastHash },
    });
    // O flush não lança e o `record` pode ter sido descartado (ou um dreno em curso ainda não
    // o pegou): só a leitura prova que entrou, então tenta mais algumas voltas.
    let confirmed = false;
    for (let i = 0; i < CONFIRM_ATTEMPTS && !confirmed && !stopped; i++) {
      await deps.audit.flush();
      const written = await col.find({
        where: { action: PURGE_ACTION, seq: { gt: toSeq } },
        orderBy: { field: 'seq', direction: 'desc' },
        limit: 10,
      });
      confirmed = written.some((row) => {
        const d = row['details'] as JsonObject | undefined;
        return d?.['fromSeq'] === fromSeq && d?.['toSeq'] === toSeq && d?.['lastHash'] === lastHash;
      });
    }
    if (!confirmed) {
      if (!stopped) deps.log().event(LOG.auditPurgeSkipped, { fromSeq, toSeq });
      return 0;
    }
    // Em lotes por `seq` (ADR 0122). Parar no meio deixa um prefixo menor apagado, que o verify
    // aceita (o purge cobre o intervalo todo) e a próxima passada conclui.
    for (let upTo = fromSeq; !stopped && upTo < toSeq; ) {
      upTo = Math.min(upTo + DELETE_BATCH - 1, toSeq);
      await col.delete({ seq: { lte: upTo } });
    }
    ok = !stopped;
    if (!stopped) deps.log().event(LOG.auditPurged, { fromSeq, toSeq, count });
    return count;
  }

  function purge(): Promise<number> {
    // O `running` é também a guarda de recursão: o flush do próprio purge dispara `tick`.
    running ??= (async () => {
      ok = false;
      try {
        return await purgeOnce();
      } catch (error) {
        // Falha antes do delete completo não perde nada; o próximo gatilho refaz.
        deps.log().event(LOG.auditPurgeFailed, { err: error });
        return 0;
      } finally {
        if (ok) lastOk = performance.now();
        running = undefined;
      }
    })();
    return running;
  }

  return {
    purge,
    tick() {
      if (!active || running !== undefined) return;
      if (lastOk !== undefined && performance.now() - lastOk < DAY_MS) return;
      void purge();
    },
    start() {
      active = true;
      stopped = false;
    },
    async stop() {
      active = false;
      stopped = true;
      await running;
    },
  };
}
