// Retenção e expurgação da auditoria (ADR 0122). O corte é por `at`, mas o que se apaga é um
// prefixo contíguo em `seq` (o relógio pode ter voltado): acha o maior `seq` vencido e apaga até ele.
// Ordem que mantém a cadeia explicada: grava `kernel.audit.purge`, confirma que entrou, só então apaga.

import { BotConfigError } from '#config/owners.ts';
import * as LOG from '#logger/events.ts';
import type { Logger } from '#logger/types.ts';
import type { Collection, JsonObject } from '#storage/types.ts';
import type { Audit } from './audit.ts';
import { PURGE_ACTION } from './verify.ts';

export const DEFAULT_RETENTION_DAYS = 1825;
const DAY_MS = 86_400_000;

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
  readonly now?: () => Date;
}

export interface AuditRetention {
  /** Uma expurgação agora. Nunca lança; devolve quantos eventos apagou. */
  purge(): Promise<number>;
  /**
   * Chamado quando a auditoria gravou eventos: expurga se faz 24 h da última passada (a primeira
   * é a primeira gravação depois de `start`). Sem timer: não há o que expurgar sem gravar.
   */
  tick(): void;
  start(): void;
  stop(): void;
}

export function createAuditRetention(deps: AuditRetentionDeps): AuditRetention {
  const now = deps.now ?? (() => new Date());
  let running: Promise<number> | undefined;
  let active = false;
  let lastRun: number | undefined;

  async function purgeOnce(): Promise<number> {
    const col = deps.collection();
    const cutoff = new Date(now().getTime() - deps.retentionDays * DAY_MS).toISOString();
    const [last] = await col.find({
      where: { at: { lt: cutoff } },
      orderBy: { field: 'seq', direction: 'desc' },
      limit: 1,
    });
    if (last === undefined) return 0;
    const toSeq = last['seq'] as number;
    const lastHash = last['hash'] as string;
    const [firstRow] = await col.find({ orderBy: 'seq', limit: 1 });
    const fromSeq = firstRow?.['seq'] as number;
    const count = toSeq - fromSeq + 1;

    deps.audit.record({
      action: PURGE_ACTION,
      actor: { kind: 'system' },
      details: { fromSeq, toSeq, count, lastHash },
    });
    await deps.audit.flush();
    // O flush não lança e o `record` pode ter sido descartado: só a leitura prova que entrou.
    const written = await col.find({
      where: { action: PURGE_ACTION, seq: { gt: toSeq } },
      orderBy: { field: 'seq', direction: 'desc' },
      limit: 10,
    });
    const confirmed = written.some((row) => {
      const d = row['details'] as JsonObject | undefined;
      return d?.['fromSeq'] === fromSeq && d?.['toSeq'] === toSeq && d?.['lastHash'] === lastHash;
    });
    if (!confirmed) {
      deps.log().event(LOG.auditPurgeSkipped, { fromSeq, toSeq });
      return 0;
    }
    await col.delete({ seq: { lte: toSeq } });
    deps.log().event(LOG.auditPurged, { fromSeq, toSeq, count });
    return count;
  }

  function purge(): Promise<number> {
    running ??= purgeOnce()
      .catch((error: unknown) => {
        // Falha antes do delete não apaga nada; a próxima passada refaz.
        deps.log().event(LOG.auditPurgeFailed, { err: error });
        return 0;
      })
      .finally(() => {
        running = undefined;
      });
    return running;
  }

  return {
    purge,
    tick() {
      const t = now().getTime();
      if (!active || (lastRun !== undefined && t - lastRun < DAY_MS)) return;
      lastRun = t;
      void purge();
    },
    start() {
      active = true;
    },
    stop() {
      active = false;
    },
  };
}
