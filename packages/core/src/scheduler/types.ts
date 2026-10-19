// Contrato do scheduler (M1-11). A implementação é `createSchedulerService` (service.ts); a
// semântica de entrega está em docs/scheduler.md.

import type { JsonValue } from '#storage/types.ts';
import type { Unsubscribe } from '#transport/types.ts';
import type { RecurrenceRule } from './rule.ts';

/** Segundo argumento do handler de job. */
export interface JobContext {
  /**
   * Aborta quando o handler estoura o prazo (`timeouts.jobMs`), com `reason` = o erro de
   * timeout. Repasse a `fetch`/SDKs para parar o trabalho a tempo (ADR 0029).
   */
  readonly signal: AbortSignal;
  /** Horário previsto (`fireAt`) desta ocorrência; após downtime, é o horário antigo. */
  readonly scheduledAt: Date;
  /** Id da série (o de `every`); ausente em job de `at`. */
  readonly seriesId?: string;
}

/**
 * Recebe o payload agendado (`null` quando `at` não recebeu payload) e o `JobContext`. Handler
 * de um parâmetro só segue valendo.
 */
export type JobHandler = (payload: JsonValue, job: JobContext) => unknown;

/** Agendamento visto pelo plugin (`ctx.scheduler`); jobs ficam no namespace do plugin. */
export interface Scheduler {
  /**
   * Agenda `job` para `when` (Date ou epoch ms) e devolve o id do agendamento. O job é
   * persistido: sobrevive a restart. Horário no passado dispara assim que possível. Rejeita com
   * `TypeError` para horário inválido, nome vazio ou payload que não é JSON.
   */
  at(when: Date | number, job: string, payload?: JsonValue): Promise<string>;
  /**
   * Agenda `job` de forma recorrente e devolve o id da série (não muda entre ocorrências). Após
   * downtime, a ocorrência vencida dispara uma vez e a próxima segue a regra a partir de agora.
   * Rejeita com `TypeError` para regra inválida, nome vazio ou payload que não é JSON.
   */
  every(rule: RecurrenceRule, job: string, payload?: JsonValue): Promise<string>;
  /**
   * Horário da próxima ocorrência pendente do job ou série do plugin; `undefined` se não existe
   * (ou é de outro plugin) ou se o job `at` já disparou.
   */
  next(id: string): Promise<Date | undefined>;
  /**
   * `true` se o agendamento existia e ainda não tinha disparado. Série: encerra as ocorrências
   * futuras e devolve `true` mesmo com o handler rodando.
   */
  cancel(id: string): Promise<boolean>;
  /** Um handler por job; um segundo `on` do mesmo job lança `JobHandlerConflictError`. */
  on(job: string, handler: JobHandler): Unsubscribe;
}
