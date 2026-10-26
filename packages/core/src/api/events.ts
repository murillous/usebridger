// Tempo real da API por SSE (ADR 0125, 0129): um stream por sessão com os eventos de conexão, de
// log e de plugin. Todo evento leva `id`; o buffer curto deixa o `EventSource` retomar pelo
// `Last-Event-ID` sem perder nem duplicar o que ainda está nele.

import { randomBytes } from 'node:crypto';
import type { z } from 'zod';
import type { ApiActor } from '#auth/types.ts';
import type { LogSignal } from '#observers/observers.ts';
import type { DisconnectReason, Unsubscribe } from '#transport/types.ts';
import { apiLibs } from './libs.ts';
import type { AnyApiOperation } from './operation.ts';
import { ApiError } from './problem.ts';

export interface StreamEvents {
  readonly 'connection.status': {
    readonly status: 'connecting' | 'open' | 'closed';
    readonly reason?: DisconnectReason;
  };
  readonly 'connection.qr': { readonly qr: string; readonly expiresAt?: number };
  readonly 'connection.pairing-code': { readonly code: string };
  readonly log: LogSignal;
  readonly 'plugin.status': {
    readonly name: string;
    readonly status: 'loaded' | 'skipped';
    /** `kind` do motivo do `skipped` (`disabled`, `setup-failed`...). */
    readonly reason?: string;
  };
}

export type StreamEventType = keyof StreamEvents;

export const STREAM_EVENT_TYPES: readonly [StreamEventType, ...StreamEventType[]] = [
  'connection.status',
  'connection.qr',
  'connection.pairing-code',
  'log',
  'plugin.status',
];

export interface StreamEvent<T extends StreamEventType = StreamEventType> {
  readonly id: string;
  readonly seq: number;
  readonly type: T;
  readonly data: StreamEvents[T];
}

/** Eventos guardados para a retomada; o log é o que mais enche. */
const BUFFER_SIZE = 1000;
/** Eventos na fila de um cliente lento antes de o servidor fechar o stream; ele retoma pelo id. */
const CLIENT_QUEUE = 1000;
const HEARTBEAT_MS = 15_000;

/** Linhas de log que carregam o QR ou o código: dão acesso à conta como o próprio evento. */
const PAIRING_LOG_EVENTS: ReadonlySet<string> = new Set([
  'connection.qr.value',
  'connection.pairing-code.value',
]);

const PAIRING_TYPES: ReadonlySet<StreamEventType> = new Set([
  'connection.qr',
  'connection.pairing-code',
]);

export class EventStream {
  /** Muda a cada processo: id de outro boot não casa com a sequência daqui. */
  readonly #boot = randomBytes(4).toString('hex');
  #seq = 0;
  #buffer: StreamEvent[] = [];
  /** Último evento de conexão de cada tipo, para quem chega sem `Last-Event-ID`. */
  readonly #latest = new Map<StreamEventType, StreamEvent>();
  readonly #subscribers = new Set<(event: StreamEvent | null) => void>();

  publish<T extends StreamEventType>(type: T, data: StreamEvents[T]): void {
    this.#seq += 1;
    const event: StreamEvent = { id: `${this.#boot}-${this.#seq}`, seq: this.#seq, type, data };
    this.#buffer.push(event);
    // Corte em lote: `push` amortizado O(1), porque o log passa por aqui a cada linha.
    if (this.#buffer.length > BUFFER_SIZE * 2) this.#buffer = this.#buffer.slice(-BUFFER_SIZE);
    if (type === 'connection.status') {
      this.#latest.set(type, event);
      // QR e código de uma tentativa que acabou não servem mais para quem chega.
      if ((data as StreamEvents['connection.status']).status !== 'connecting') {
        for (const pairing of PAIRING_TYPES) this.#latest.delete(pairing);
      }
    } else if (PAIRING_TYPES.has(type)) {
      this.#latest.set(type, event);
    }
    for (const subscriber of this.#subscribers) subscriber(event);
  }

  /**
   * O que mandar antes do ao vivo: com `Last-Event-ID` deste processo, o que veio depois dele;
   * sem ele (ou de outro processo), o estado atual da conexão.
   */
  replay(lastEventId: string | null): StreamEvent[] {
    const match = lastEventId?.match(/^([0-9a-f]+)-(\d+)$/);
    if (match?.[1] === this.#boot) {
      const after = Number(match[2]);
      return this.#buffer.slice(-BUFFER_SIZE).filter((event) => event.seq > after);
    }
    return [...this.#latest.values()].sort((a, b) => a.seq - b.seq);
  }

  /** `null` avisa que o stream acabou (bot parando). */
  subscribe(fn: (event: StreamEvent | null) => void): Unsubscribe {
    this.#subscribers.add(fn);
    return () => this.#subscribers.delete(fn);
  }

  /** Fecha os streams abertos; o cliente reconecta quando o bot voltar. */
  close(): void {
    for (const subscriber of [...this.#subscribers]) subscriber(null);
    this.#subscribers.clear();
  }
}

/** O ator vê o evento? Sem ator (auth desligada, só em loopback) vê tudo. */
function visible(event: StreamEvent, actor: ApiActor | undefined): boolean {
  const can = (permission: string): boolean =>
    actor === undefined || actor.permissions.includes(permission);
  if (PAIRING_TYPES.has(event.type)) return can('connection.manage');
  if (event.type === 'log') {
    if (!can('logs.read')) return false;
    const name = (event.data as LogSignal).fields['event'];
    return !(typeof name === 'string' && PAIRING_LOG_EVENTS.has(name)) || can('connection.manage');
  }
  return true;
}

function frame(event: StreamEvent): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

let schemas: { readonly item: z.ZodType; readonly query: z.ZodType } | undefined;

function streamSchemas(): NonNullable<typeof schemas> {
  const { z } = apiLibs();
  if (schemas !== undefined) return schemas;
  const reason = z.enum([
    'qr-timeout',
    'logged-out',
    'auth-failed',
    'fatal',
    'replaced',
    'server-error',
    'connection-lost',
    'unknown',
  ] satisfies DisconnectReason[]);
  // Cada item é componente nomeado: o `openapi-typescript` ignora o `itemSchema` (ADR 0125). O
  // `data` vai como objeto, o que o cliente tem depois do `JSON.parse` da linha `data:`.
  const event = <T extends string, D extends z.ZodType>(name: T, data: D, id: string) =>
    z.object({ id: z.string(), event: z.literal(name), data }).meta({ id });
  const item = z
    .union([
      event(
        'connection.status',
        z.object({ status: z.enum(['connecting', 'open', 'closed']), reason: reason.optional() }),
        'ConnectionStatusEvent',
      ),
      event(
        'connection.qr',
        z.object({ qr: z.string(), expiresAt: z.number().optional() }),
        'ConnectionQrEvent',
      ),
      event(
        'connection.pairing-code',
        z.object({ code: z.string() }),
        'ConnectionPairingCodeEvent',
      ),
      event(
        'log',
        z.object({
          level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']),
          time: z.number(),
          message: z.string(),
          fields: z.record(z.string(), z.unknown()),
        }),
        'LogEvent',
      ),
      event(
        'plugin.status',
        z.object({
          name: z.string(),
          status: z.enum(['loaded', 'skipped']),
          reason: z.string().optional(),
        }),
        'PluginStatusEvent',
      ),
    ])
    .meta({ id: 'StreamEvent' });
  const query = z.object({
    // Lista separada por vírgula (`?types=log,connection.status`); ausente: todos os tipos.
    types: z
      .string()
      .optional()
      .transform((value) => (value === undefined ? undefined : value.split(',')))
      .pipe(z.array(z.enum(STREAM_EVENT_TYPES)).optional()),
  });
  schemas = { item, query };
  return schemas;
}

/** Precisa de `loadApiLibs()` antes. Sem `stream` (spec offline), a rota existe só na spec. */
export function eventsOperation(stream?: EventStream): AnyApiOperation {
  const { item, query } = streamSchemas();
  return {
    method: 'GET',
    path: '/events',
    summary: 'Eventos em tempo real (SSE), retomáveis pelo Last-Event-ID',
    tags: ['connection'],
    permission: 'connection.read',
    query,
    response: item,
    stream: true,
    handler: ({ query, actor }, request) => {
      if (stream === undefined) throw new ApiError(404);
      const types = (query as { types?: StreamEventType[] }).types;
      const wanted = (event: StreamEvent): boolean =>
        (types === undefined || types.includes(event.type)) && visible(event, actor);
      return sseResponse(stream, request.headers.get('last-event-id'), wanted, request.signal);
    },
  };
}

function sseResponse(
  stream: EventStream,
  lastEventId: string | null,
  wanted: (event: StreamEvent) => boolean,
  signal: AbortSignal,
): Response {
  const encoder = new TextEncoder();
  let stop = (): void => undefined;
  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        let open = true;
        const write = (text: string): void => {
          if (!open) return;
          // Cliente que não lê: fecha em vez de acumular; ele retoma pelo último id que recebeu.
          if ((controller.desiredSize ?? 0) <= 0) end();
          else controller.enqueue(encoder.encode(text));
        };
        const end = (): void => {
          if (!open) return;
          open = false;
          unsubscribe();
          clearInterval(heartbeat);
          signal.removeEventListener('abort', end);
          try {
            controller.close();
          } catch {
            // Já cancelado pelo cliente: não há o que fechar.
            void 0;
          }
        };
        stop = end;
        // Assina antes do replay: nada publicado entre os dois se perde, e o `seq` evita repetir.
        const pending: StreamEvent[] = [];
        let live = false;
        let last = 0;
        const send = (event: StreamEvent): void => {
          if (event.seq <= last) return;
          last = event.seq;
          if (wanted(event)) write(frame(event));
        };
        const unsubscribe = stream.subscribe((event) => {
          if (event === null) end();
          else if (live) send(event);
          else pending.push(event);
        });
        // Comentário SSE: mantém o proxy sem cortar por inatividade.
        const heartbeat = setInterval(() => write(': ping\n\n'), HEARTBEAT_MS);
        heartbeat.unref();
        signal.addEventListener('abort', end, { once: true });
        // `retry` curto: depois de uma queda, o browser volta antes de o buffer girar.
        write('retry: 2000\n\n');
        for (const event of stream.replay(lastEventId)) send(event);
        live = true;
        for (const event of pending.splice(0)) send(event);
      },
      cancel() {
        stop();
      },
    },
    { highWaterMark: CLIENT_QUEUE },
  );
  return new Response(body, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      // nginx guarda a resposta inteira por padrão; o stream precisa sair na hora.
      'x-accel-buffering': 'no',
    },
  });
}
