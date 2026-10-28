// Histórico de logs pela API (ADR 0125, 0135): as linhas recentes do processo, no mesmo formato do
// evento `log` do SSE, com filtros e cursor. É memória, não storage: o restart começa vazio, e o
// log durável continua sendo o do destino do logger (stdout, agregador).

import type { z } from 'zod';
import type { EmitLevel } from '#logger/types.ts';
import type { LogSignal } from '#observers/observers.ts';
import { logVisible } from './events.ts';
import { apiLibs } from './libs.ts';
import type { AnyApiOperation } from './operation.ts';
import { ApiError } from './problem.ts';

/** Linhas guardadas; o `GET /logs` não volta além disso. */
export const LOG_HISTORY = 1000;

const LEVELS: readonly [EmitLevel, ...EmitLevel[]] = [
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
];

interface Entry {
  readonly seq: number;
  readonly signal: LogSignal;
}

export interface LogFilters {
  /** Nível mínimo: `warn` traz `warn`, `error` e `fatal`. */
  readonly level?: EmitLevel;
  readonly plugin?: string;
  readonly event?: string;
  /** `Date.now()` inclusivo. */
  readonly from?: number;
  readonly to?: number;
}

export interface LogPage {
  readonly logs: LogSignal[];
  /** Cursor da página seguinte (mais antiga); ausente quando não há mais nada no buffer. */
  readonly next?: number;
}

export class LogHistory {
  #seq = 0;
  #entries: Entry[] = [];

  push(signal: LogSignal): void {
    this.#seq += 1;
    this.#entries.push({ seq: this.#seq, signal });
    // Corte em lote: `push` amortizado O(1), porque toda linha de log passa por aqui.
    if (this.#entries.length > LOG_HISTORY * 2) this.#entries = this.#entries.slice(-LOG_HISTORY);
  }

  /**
   * Da mais nova para a mais antiga. `before` é o `next` da página anterior; `visible` tira o que o
   * ator não pode ver sem furar a página.
   */
  page(
    filters: LogFilters,
    options: { before?: number; limit: number; visible: (signal: LogSignal) => boolean },
  ): LogPage {
    const min = filters.level === undefined ? 0 : LEVELS.indexOf(filters.level);
    const matches = ({ seq, signal }: Entry): boolean =>
      (options.before === undefined || seq < options.before) &&
      LEVELS.indexOf(signal.level) >= min &&
      (filters.plugin === undefined || signal.fields['plugin'] === filters.plugin) &&
      (filters.event === undefined || signal.fields['event'] === filters.event) &&
      (filters.from === undefined || signal.time >= filters.from) &&
      (filters.to === undefined || signal.time <= filters.to) &&
      options.visible(signal);
    const entries = this.#entries.slice(-LOG_HISTORY);
    const found: Entry[] = [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i] as Entry;
      if (!matches(entry)) continue;
      // Uma além do limite só para saber se há próxima página: o cliente não pede uma vazia.
      if (found.length === options.limit) {
        const last = found.at(-1) as Entry;
        return { logs: found.map((e) => e.signal), next: last.seq };
      }
      found.push(entry);
    }
    return { logs: found.map((e) => e.signal) };
  }
}

let schemas: { readonly query: z.ZodType; readonly page: z.ZodType } | undefined;

function logSchemas(): NonNullable<typeof schemas> {
  if (schemas !== undefined) return schemas;
  const { z } = apiLibs();
  const line = z
    .object({
      level: z.enum(LEVELS),
      time: z.number(),
      message: z.string(),
      fields: z.record(z.string(), z.unknown()),
    })
    .meta({ id: 'LogLine' });
  schemas = {
    query: z.object({
      level: z.enum(LEVELS).optional().meta({ description: 'Nível mínimo' }),
      plugin: z.string().optional().meta({ description: 'Campo `plugin` da linha' }),
      event: z.string().optional().meta({ description: 'Campo `event` da linha (ADR 0118)' }),
      from: z.iso.datetime().optional().meta({ description: 'Início (inclusivo)' }),
      to: z.iso.datetime().optional().meta({ description: 'Fim (inclusivo)' }),
      before: z.coerce
        .number()
        .int()
        .positive()
        .optional()
        .meta({ description: 'Cursor: o `next` da página anterior' }),
      limit: z.coerce.number().int().min(1).max(LOG_HISTORY).default(100),
    }),
    page: z
      .object({
        logs: z.array(line),
        next: z.number().optional().meta({ description: 'Cursor da próxima página (mais antiga)' }),
      })
      .meta({ id: 'LogPage' }),
  };
  return schemas;
}

/** Precisa de `loadApiLibs()` antes. Sem `history` (spec offline), a rota existe só na spec. */
export function logsOperation(history?: LogHistory): AnyApiOperation {
  const { query, page } = logSchemas();
  return {
    method: 'GET',
    path: '/logs',
    summary: 'Linhas recentes de log, da mais nova para a mais antiga, com cursor',
    tags: ['logs'],
    permission: 'logs.read',
    query,
    response: page,
    handler: ({ query: q, actor }) => {
      if (history === undefined) throw new ApiError(404);
      const { level, plugin, event, from, to, before, limit } = q as {
        level?: EmitLevel;
        plugin?: string;
        event?: string;
        from?: string;
        to?: string;
        before?: number;
        limit: number;
      };
      return history.page(
        {
          ...(level !== undefined && { level }),
          ...(plugin !== undefined && { plugin }),
          ...(event !== undefined && { event }),
          ...(from !== undefined && { from: Date.parse(from) }),
          ...(to !== undefined && { to: Date.parse(to) }),
        },
        {
          ...(before !== undefined && { before }),
          limit,
          visible: (signal) => logVisible(signal, actor),
        },
      );
    },
  };
}
