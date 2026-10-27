// Entrada do transport no bot: assina os eventos do transport e decide para onde cada um vai
// (fila do chat, barramento, reconector). Separado do `createBot`, que cuida do boot e do
// shutdown; aqui o estado do bot chega por `deps`, em getters onde ele muda.

import type { ConversationRegistry } from '#conversations/conversations.ts';
import type { EventBus } from '#events/bus.ts';
import type { BotEvents } from '#events/types.ts';
import * as LOG from '#logger/events.ts';
import { NO_TRAIL, type Trail } from '#logger/trail.ts';
import type { Logger } from '#logger/types.ts';
import type { Chat, Contact, Message } from '#message/types.ts';
import type { Observers } from '#observers/observers.ts';
import type { OutboundQueue } from '#outbound/queue.ts';
import type { InboundQueue } from '#queue/inbound.ts';
import type { TenantScope } from '#tenant/scope.ts';
import { newTraceId, runInTrace } from '#trace/scope.ts';
import type {
  ConnectionStatus,
  Interaction,
  Transport,
  TransportEvents,
} from '#transport/types.ts';
import { DIRECT_EVENTS, type DirectEvent } from './direct-events.ts';
import type { InboundFlow } from './inbound-flow.ts';
import type { ExpireOrigin, KernelMessageContext } from './message-context.ts';
import type { ReadyGate } from './ready-gate.ts';
import type { Reconnector } from './reconnect.ts';

export interface TransportEntryDeps {
  readonly transport: Transport;
  readonly inbound: InboundQueue;
  /** `pause()`/`resume()` no `connection.status`. */
  readonly outbound: OutboundQueue;
  readonly tenants: TenantScope;
  readonly flow: InboundFlow;
  readonly bus: EventBus;
  /** O `queuedMs` do `message.handled` só é medido com observador (ADR 0102). */
  readonly observers?: Pick<Observers, 'has'>;
  readonly conversations: Pick<ConversationRegistry<KernelMessageContext, ExpireOrigin>, 'expire'>;
  readonly reconnector: Reconnector | undefined;
  readonly gate: ReadyGate;
  /** Os filtros do pipeline, para os eventos que não passam por ele (ADR 0034). */
  readonly chatIsAllowed: (chat: Pick<Chat, 'id' | 'parentId'>) => boolean;
  readonly dropsSelf: boolean;
  readonly dropsBots: boolean;
  /** `true` em `stopping`/`stopped`/`failed`: a espera vencida some em silêncio. */
  readonly stopping: () => boolean;
  /** Guarda o último `connection.status`, antes de reemitir no barramento (ADR 0106). */
  readonly recordStatus?: (status: ConnectionStatus) => void;
  /** Guarda o QR (expiração, ADR 0111; stream da API, ADR 0129), antes de reemitir no barramento. */
  readonly recordQr?: (payload: TransportEvents['connection.qr']) => void;
  /** Leva o código de pareamento ao stream da API (ADR 0129), antes de reemitir no barramento. */
  readonly recordPairingCode?: (payload: TransportEvents['connection.pairing-code']) => void;
  /** O giveUp da reconexão já levou o bot a `failed` (ADR 0116). */
  readonly failed?: () => boolean;
  /** Trilha de eventos (ADR 0120). Padrão: desligada. */
  readonly trail?: Trail;
  /** Getter: o logger nasce no `start()`. */
  readonly log: () => Logger;
}

export interface TransportEntry {
  /** Assina todos os eventos do transport; devolve a função que desfaz. */
  subscribe(): () => void;
  /** Ponto único da expiração de uma espera (ADR 0093). */
  expireWait(chat: Chat, sender: Contact): void;
}

export function createTransportEntry(deps: TransportEntryDeps): TransportEntry {
  // Cada unidade de trabalho nasce com o trace próprio, dentro do escopo do tenant.
  const work = <R>(tenant: string | undefined, fn: () => R): R =>
    runInTrace(newTraceId(), () => deps.tenants.run(tenant, fn));

  /**
   * Põe a mensagem (nova ou editada) ou o clique na fila do chat dele: o mesmo chat anda em
   * série. A tarefa roda no escopo do tenant do chat (ADR 0068). Com observador de
   * `message.handled`, mede a espera na fila e a passa ao fluxo (ADR 0102).
   */
  function enqueue<T extends Message | Interaction>(
    item: T,
    handle: (item: T, queuedMs?: number) => Promise<void>,
  ): void {
    const enqueuedAt = deps.observers?.has('message.handled') ? performance.now() : undefined;
    const result = deps.inbound.enqueue(item.chat.id, () =>
      work(item.chat.tenantId, () =>
        handle(item, enqueuedAt === undefined ? undefined : performance.now() - enqueuedAt),
      ),
    );
    if (result !== 'queued') {
      deps.log().event(LOG.messageDropped, {
        chat: item.chat.id,
        messageId: item.id,
        reason: result,
      });
    }
  }

  /**
   * Ponto único da expiração de uma espera (ADR 0093): põe na fila do chat a tarefa que retira a
   * espera vencida e roda o `onExpire` do passo, para não correr junto com uma mensagem do mesmo
   * chat. Chamado pelo timer da espera; uma espera restaurada que venceu durante o restart passa
   * por aqui no boot. No `stop()`, ou com a fila do chat cheia ou fechada, a espera vencida some
   * em silêncio, como antes do `onExpire`.
   */
  function expireWait(chat: Chat, sender: Contact): void {
    if (deps.stopping()) {
      deps.conversations.expire(chat.id, sender.id);
      return;
    }
    const result = deps.inbound.enqueue(chat.id, () =>
      work(chat.tenantId, () => deps.flow.expireReply(chat, sender)),
    );
    if (result === 'queued') return;
    const expired = deps.conversations.expire(chat.id, sender.id);
    // A espera some sem o `onExpire`, mas o fato é da trilha; um trace só para a trilha e o aviso.
    work(chat.tenantId, () => {
      if (expired !== undefined) {
        (deps.trail ?? NO_TRAIL).emit(LOG.stepExpired, {
          plugin: expired.plugin,
          step: expired.step,
        });
      }
      deps.log().event(LOG.expireDropped, {
        chat: chat.id,
        reason: result,
      });
    });
  }

  /**
   * Repassa um evento que não é mensagem ao barramento, depois do `chatFilter`, do `ignoreSelf` e
   * do `ignoreBots` (ADR 0034). Durante o boot, espera os plugins subirem; sem fila do chat.
   */
  function forward<E extends DirectEvent>(event: E): () => void {
    const origin = DIRECT_EVENTS[event];
    return deps.transport.on(event, (transportPayload) => {
      // `BotEvents` estende `TransportEvents`: o payload é o mesmo tipo.
      const payload = transportPayload as BotEvents[E];
      const { chat, fromMe, fromBot } = origin(payload);
      if ((fromMe && deps.dropsSelf) || (fromBot && deps.dropsBots)) return;
      if (chat !== null && !deps.chatIsAllowed(chat)) return;
      // Os listeners rodam no escopo do tenant do chat (ADR 0068). Ele vem do payload, não da
      // origem: entrada e saída do grupo passam pelo filtro sem chat, mas são de um tenant.
      const tenant = 'chat' in payload ? payload.chat.tenantId : undefined;
      work(tenant, () => {
        if (deps.gate.ready) {
          void deps.bus.emit(event, payload);
          return;
        }
        // Boot abortado ou `stop()` antes do fim: o evento é descartado, como a mensagem.
        void deps.gate.promise.then((ok) => {
          if (ok) void deps.bus.emit(event, payload);
        });
      });
    });
  }

  /** Assina todos os eventos do transport; devolve a função que desfaz. */
  function subscribe(): () => void {
    const offs: (() => void)[] = [
      deps.transport.on('message', (message) => enqueue(message, deps.flow.handleMessage)),
      deps.transport.on('message.edited', (message) => enqueue(message, deps.flow.handleEdited)),
      deps.transport.on('interaction', (interaction) =>
        enqueue(interaction, deps.flow.handleInteraction),
      ),
      deps.transport.on('connection.status', (status) => {
        // `failed`: o status final é o do erro; o `closed` do nosso próprio disconnect não o apaga.
        if (deps.failed?.()) return;
        // Com a conexão caída, o envio falharia e esgotaria o retry antes da reconexão (#198).
        if (status.status === 'closed') deps.outbound.pause();
        else if (status.status === 'open') deps.outbound.resume();
        deps.recordStatus?.(status);
        deps.reconnector?.onStatus(status);
        void deps.bus.emit('connection.status', status);
      }),
      deps.transport.on('connection.qr', (payload) => {
        deps.reconnector?.onQr();
        deps.recordQr?.(payload);
        // Quem lê o log em info (agregador, arquivo) pareia o número com o QR enquanto ele vale:
        // o valor fica em debug e no barramento (`connection.qr`), para quem exibe a tela.
        deps.log().event(LOG.pairingQr);
        deps.log().event(LOG.pairingQrValue, { qr: payload.qr });
        void deps.bus.emit('connection.qr', payload);
      }),
      deps.transport.on('connection.pairing-code', (payload) => {
        // Mesma tentativa de pareamento que o QR (ADR 0046), e o mesmo risco no log.
        deps.reconnector?.onQr();
        deps.recordPairingCode?.(payload);
        deps.log().event(LOG.pairingCode);
        deps.log().event(LOG.pairingCodeValue, { code: payload.code });
        void deps.bus.emit('connection.pairing-code', payload);
      }),
    ];
    for (const event of Object.keys(DIRECT_EVENTS) as DirectEvent[]) offs.push(forward(event));
    return () => {
      for (const off of offs.splice(0)) off();
    };
  }

  return { subscribe, expireWait };
}
