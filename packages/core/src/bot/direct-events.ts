import type { EmittableEventName } from '#events/bus.ts';
import type { BotEvents } from '#events/types.ts';
import type { Chat } from '#message/types.ts';

/** Eventos do transport que não são mensagem: vão ao barramento sem fila nem middlewares. */
export type DirectEvent = Extract<
  EmittableEventName,
  | 'message.deleted'
  | 'reaction'
  | 'poll.vote'
  | 'group.joined'
  | 'group.left'
  | 'group.participants'
  | 'group.updated'
  | 'contact.updated'
>;

/** O que os filtros leem de um evento; `chat: null` = não passa pelo `chatFilter`. */
interface EventOrigin {
  /** Com o `parentId`, para o `chatFilter` casar também o espaço. */
  readonly chat: Pick<Chat, 'id' | 'parentId'> | null;
  readonly fromMe: boolean;
  /** Autor do evento, para o `ignoreBots`. */
  readonly fromBot: boolean;
}

const ALWAYS_PASSES: EventOrigin = { chat: null, fromMe: false, fromBot: false };

/**
 * Origem de cada evento direto, para o `chatFilter`, o `ignoreSelf` e o `ignoreBots`.
 */
export const DIRECT_EVENTS: {
  readonly [E in DirectEvent]: (payload: BotEvents[E]) => EventOrigin;
} = {
  'message.deleted': (payload) => ({
    chat: payload.chat,
    fromMe: payload.fromMe,
    fromBot: payload.deletedBy?.isBot === true,
  }),
  reaction: (payload) => ({
    chat: payload.chat,
    fromMe: payload.fromMe,
    fromBot: payload.sender.isBot === true,
  }),
  'poll.vote': (payload) => ({
    chat: payload.chat,
    fromMe: payload.fromMe,
    fromBot: payload.sender.isBot === true,
  }),
  // Entrada e saída do grupo são o ciclo de vida do próprio bot: servem para o plugin limpar
  // estado, então passam mesmo com o grupo bloqueado.
  'group.joined': () => ALWAYS_PASSES,
  'group.left': () => ALWAYS_PASSES,
  'group.participants': (payload) => ({ chat: payload.chat, fromMe: false, fromBot: false }),
  'group.updated': (payload) => ({ chat: payload.chat, fromMe: false, fromBot: false }),
  // Contato não é de um chat: bloquear um chat não esconde quem está nele de outros chats.
  'contact.updated': () => ALWAYS_PASSES,
};
