// Auditoria pela API (ADR 0133): consulta paginada e exportação em stream sobre o `audit.query`, e
// o `verify` da cadeia (ADR 0122). A exportação tira os dados do bot em massa: entra na auditoria.

import type { z } from 'zod';
import type { Audit } from '#audit/audit.ts';
import type { AuditEvent, AuditPage, AuditQuery } from '#audit/types.ts';
import * as LOG from '#logger/events.ts';
import type { Logger } from '#logger/types.ts';
import { apiLibs } from './libs.ts';
import type { AnyApiOperation } from './operation.ts';
import { ApiError } from './problem.ts';

export interface AuditApiDeps {
  /** Getter: a auditoria nasce depois do servidor HTTP no `createBot`. */
  readonly audit: () => Pick<Audit, 'query' | 'verify' | 'record'>;
  /** Lido a cada uso: o logger do bot nasce no `start()`. */
  readonly log: () => Logger;
}

/** Página do `audit.query` usada pela exportação: o máximo que ele aceita. */
const EXPORT_PAGE = 1000;

const CSV_COLUMNS = [
  'seq',
  'eventId',
  'at',
  'actorKind',
  'actorId',
  'actorName',
  'onBehalfOf',
  'via',
  'action',
  'targetType',
  'targetId',
  'outcome',
  'ip',
  'userAgent',
  'tenant',
  'session',
  'trace',
  'details',
  'prevHash',
  'hash',
] as const;

type Filters = Pick<AuditQuery, 'from' | 'to' | 'actor' | 'action' | 'target' | 'outcome'>;

let schemas:
  | {
      readonly list: z.ZodType;
      readonly exportQuery: z.ZodType;
      readonly page: z.ZodType;
      readonly events: z.ZodType;
      readonly verified: z.ZodType;
    }
  | undefined;

function auditSchemas(): NonNullable<typeof schemas> {
  if (schemas !== undefined) return schemas;
  const { z } = apiLibs();
  const filters = {
    from: z.iso.datetime().optional().meta({ description: 'Início (inclusivo) por `at`' }),
    to: z.iso.datetime().optional().meta({ description: 'Fim (inclusivo) por `at`' }),
    actor: z.string().optional().meta({ description: 'Id do ator (`actorId`)' }),
    action: z.string().optional(),
    target: z.string().optional().meta({ description: 'Id do alvo (`targetId`)' }),
    outcome: z.enum(['success', 'denied', 'error']).optional(),
  };
  const event = z
    .object({
      v: z.literal(1),
      eventId: z.string(),
      seq: z.number(),
      at: z.string(),
      actor: z.union([
        z.object({
          kind: z.literal('user'),
          id: z.string(),
          name: z.string(),
          onBehalfOf: z.string().optional(),
        }),
        z.object({ kind: z.literal('system') }),
        z.object({ kind: z.literal('plugin'), name: z.string() }),
        z.object({ kind: z.literal('contact'), transport: z.string(), id: z.string() }),
      ]),
      via: z.string().optional(),
      action: z.string(),
      target: z.object({ type: z.string(), id: z.string() }).optional(),
      outcome: z.enum(['success', 'denied', 'error']),
      ip: z.string().optional(),
      userAgent: z.string().optional(),
      tenant: z.string().optional(),
      session: z.string(),
      trace: z.string().optional(),
      details: z.record(z.string(), z.unknown()).optional(),
      actorId: z.string(),
      targetId: z.string().optional(),
      prevHash: z.string(),
      hash: z.string(),
    })
    .meta({ id: 'AuditEvent' });
  schemas = {
    list: z.object({
      ...filters,
      after: z.coerce
        .number()
        .int()
        .nonnegative()
        .optional()
        .meta({ description: 'Cursor: o `next` da página anterior' }),
      limit: z.coerce.number().int().min(1).max(1000).optional(),
    }),
    exportQuery: z.object({ ...filters, format: z.enum(['csv', 'json']).default('json') }),
    page: z
      .object({
        events: z.array(event),
        next: z.number().optional().meta({ description: 'Cursor da próxima página' }),
      })
      .meta({ id: 'AuditPage' }),
    events: z.array(event).meta({ id: 'AuditExport' }),
    verified: z
      .object({
        ok: z.boolean(),
        checked: z.number(),
        brokenAt: z.object({ seq: z.number(), eventId: z.string(), reason: z.string() }).optional(),
      })
      .meta({ id: 'AuditVerifyResult' }),
  };
  return schemas;
}

/** Só os filtros informados: `undefined` não vai para o `query` nem para o evento da exportação. */
function pickFilters(input: Filters): Filters {
  const out: Record<string, string> = {};
  for (const key of ['from', 'to', 'actor', 'action', 'target', 'outcome'] as const) {
    const value = input[key];
    if (value !== undefined) out[key] = value;
  }
  return out as Filters;
}

function csvCell(value: unknown): string {
  if (value === undefined || value === null) return '';
  let text = typeof value === 'string' ? value : JSON.stringify(value);
  // Planilha executa célula que começa com fórmula; ator, alvo e details vêm de fora (CWE-1236).
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvRow(event: AuditEvent): string {
  const { actor } = event;
  const row: Record<(typeof CSV_COLUMNS)[number], unknown> = {
    seq: event.seq,
    eventId: event.eventId,
    at: event.at,
    actorKind: actor.kind,
    actorId: event.actorId,
    actorName: actor.kind === 'user' || actor.kind === 'plugin' ? actor.name : undefined,
    onBehalfOf: actor.kind === 'user' ? actor.onBehalfOf : undefined,
    via: event.via,
    action: event.action,
    targetType: event.target?.type,
    targetId: event.targetId,
    outcome: event.outcome,
    ip: event.ip,
    userAgent: event.userAgent,
    tenant: event.tenant,
    session: event.session,
    trace: event.trace,
    details: event.details,
    prevHash: event.prevHash,
    hash: event.hash,
  };
  return `${CSV_COLUMNS.map((column) => csvCell(row[column])).join(',')}\r\n`;
}

/**
 * Corpo da exportação: uma página do `query` por `pull`, então cliente lento não enche a memória.
 * A primeira página já veio (falha nela é 500 comum); falha numa seguinte corta o stream e vai pro log.
 */
function exportBody(
  deps: AuditApiDeps,
  filters: Filters,
  first: AuditPage,
  format: 'csv' | 'json',
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let page: AuditPage | undefined = first;
  let wrote = 0;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(format === 'csv' ? `${CSV_COLUMNS.join(',')}\r\n` : '['));
    },
    async pull(controller) {
      try {
        if (page === undefined) {
          if (format === 'json') controller.enqueue(encoder.encode(']'));
          controller.close();
          return;
        }
        let text = '';
        for (const event of page.events) {
          text +=
            format === 'csv' ? csvRow(event) : `${wrote > 0 ? ',' : ''}${JSON.stringify(event)}`;
          wrote++;
        }
        if (text !== '') controller.enqueue(encoder.encode(text));
        // Página cheia pode ter sucessora; a menor é a última e poupa uma ida ao storage.
        page =
          page.next !== undefined && page.events.length === EXPORT_PAGE
            ? await deps.audit().query({ ...filters, after: page.next, limit: EXPORT_PAGE })
            : undefined;
      } catch (error) {
        // O status 200 já saiu: o cliente só vê o corpo cortado, e a causa fica no log.
        deps.log().event(LOG.auditExportFailed, { err: error, exported: wrote });
        controller.error(error);
      }
    },
  });
}

/** Precisa de `loadApiLibs()` antes. Sem `deps` (spec offline), as rotas existem só na spec. */
export function auditOperations(deps?: AuditApiDeps): readonly AnyApiOperation[] {
  const { list, exportQuery, page, events, verified } = auditSchemas();
  return [
    {
      method: 'GET',
      path: '/audit',
      summary: 'Eventos da auditoria, por `seq`, com cursor',
      tags: ['audit'],
      permission: 'audit.read',
      query: list,
      response: page,
      handler: ({ query }) => {
        if (deps === undefined) throw new ApiError(404);
        const { after, limit, ...rest } = query as Filters & { after?: number; limit?: number };
        return deps.audit().query({
          ...pickFilters(rest),
          ...(after !== undefined && { after }),
          ...(limit !== undefined && { limit }),
        });
      },
    },
    {
      method: 'GET',
      path: '/audit/export',
      summary:
        'Exportação da auditoria em stream (`format=json` ou `csv`), com os filtros do `GET /audit`',
      tags: ['audit'],
      permission: 'audit.read',
      query: exportQuery,
      response: events,
      handler: async ({ query }) => {
        if (deps === undefined) throw new ApiError(404);
        const { format, ...rest } = query as Filters & { format: 'csv' | 'json' };
        const filters = pickFilters(rest);
        const audit = deps.audit();
        const details = { format, filters };
        let first: AuditPage;
        try {
          first = await audit.query({ ...filters, limit: EXPORT_PAGE });
        } catch (error) {
          audit.record({ action: 'kernel.audit.export', outcome: 'error', details });
          throw error;
        }
        audit.record({ action: 'kernel.audit.export', details });
        return new Response(exportBody(deps, filters, first, format), {
          headers: {
            'content-type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json',
            'content-disposition': `attachment; filename="audit.${format}"`,
          },
        });
      },
    },
    {
      method: 'POST',
      path: '/audit/verify',
      summary: 'Confere a cadeia de hash da auditoria e aponta o primeiro elo quebrado',
      tags: ['audit'],
      permission: 'audit.read',
      response: verified,
      handler: () => {
        if (deps === undefined) throw new ApiError(404);
        return deps.audit().verify();
      },
    },
  ];
}
