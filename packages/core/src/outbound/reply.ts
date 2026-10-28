import type { MessageAction } from '#actions/actions.ts';
import type { Message } from '#message/types.ts';
import type { MessageText } from '#text/format.ts';
import type { MessageKey, OutgoingAction, OutgoingContent } from '#transport/types.ts';
import { type QueueSendOptions, REPLY_ORIGIN, type ReplyOriginInfo } from './queue.ts';
import { captionFields, textContent } from './text.ts';
import type { Reply, ReplyOptions, ReplyTextOptions, Sender } from './types.ts';

/** Texto e botões que vão ao transport, depois de o kernel resolver as ações. */
export interface PreparedActions {
  /** O texto, com o menu numerado no fim quando o transport não leva os botões. */
  readonly text: MessageText;
  readonly actions?: readonly OutgoingAction[];
}

/** Resolve as ações de uma resposta; lança `TypeError` com uma ação inválida. */
export type PrepareActions = (
  text: MessageText,
  actions: readonly MessageAction[],
) => PreparedActions;

export interface CreateReplyOptions {
  /**
   * Cita a mensagem original. Padrão: `true`. Quem monta o contexto passa `false` quando o
   * transport não tem a capability `quoted`, para a resposta não falhar com `UnsupportedError`.
   */
  readonly quote?: boolean;
  /** Quem resolve `actions`. Sem ele, uma resposta com ações rejeita com `TypeError`. */
  readonly actions?: PrepareActions;
}

/**
 * Chat e remetente de uma resposta sem mensagem a citar: o `onExpire` de um passo responde a
 * quem não respondeu.
 */
export type ReplyOrigin = Pick<Message, 'chat' | 'sender'>;

/**
 * Monta o `ctx.reply` de uma mensagem: envia no chat dela, citando-a, com prioridade `high`,
 * pelo `sender` (a fila de saída). O plugin não vê a fila — só chama `reply`. Com uma
 * `ReplyOrigin` no lugar da mensagem, envia no chat dela sem citar.
 */
export function createReply(
  sender: Sender,
  message: Message | ReplyOrigin,
  options: CreateReplyOptions = {},
): Reply {
  const chatId = message.chat.id;
  const quoted = options.quote === false || !('key' in message) ? undefined : message;
  // Para o sinal `outbound.sent` (ADR 0102): o `ctx.send` direto não sabe o tipo do chat.
  const origin: ReplyOriginInfo = {
    chatType: message.chat.isGroup ? 'group' : 'private',
    ...('key' in message && { messageId: message.id }),
  };

  const send = (
    content: OutgoingContent,
    replyOptions: ReplyOptions = {},
    actions?: readonly OutgoingAction[],
  ): Promise<MessageKey> => {
    const sendOptions: QueueSendOptions = {
      priority: replyOptions.priority ?? 'high',
      ...(quoted && { quoted }),
      ...(replyOptions.mentions && { mentions: replyOptions.mentions }),
      ...(actions && actions.length > 0 && { actions }),
    };
    // Não enumerável: um espalhamento das opções no caminho não a leva ao transport.
    Object.defineProperty(sendOptions, REPLY_ORIGIN, { value: origin });
    return sender.send(chatId, content, sendOptions);
  };

  const sendText = (text: MessageText, o?: ReplyTextOptions): Promise<MessageKey> => {
    if (o?.actions === undefined || o.actions.length === 0) return send(textContent(text), o);
    let prepared: PreparedActions;
    try {
      if (options.actions === undefined) {
        throw new TypeError('reply: ações só no contexto de mensagem do bot');
      }
      prepared = options.actions(text, o.actions);
    } catch (error) {
      return Promise.reject(error);
    }
    return send(textContent(prepared.text), o, prepared.actions);
  };

  const shortcuts: Pick<Reply, keyof Reply> = {
    text: sendText,
    image: (media, o = {}) =>
      send({ type: 'image', media, ...captionFields(o.caption), ...pick(o, 'mimetype') }, o),
    video: (media, o = {}) =>
      send({ type: 'video', media, ...captionFields(o.caption), ...pick(o, 'mimetype') }, o),
    audio: (media, o = {}) => send({ type: 'audio', media, ...pick(o, 'mimetype') }, o),
    voice: (media, o = {}) => send({ type: 'voice', media, ...pick(o, 'mimetype') }, o),
    sticker: (media, o) => send({ type: 'sticker', media }, o),
    document: (media, o) =>
      send(
        {
          type: 'document',
          media,
          fileName: o.fileName,
          mimetype: o.mimetype,
          ...captionFields(o.caption),
        },
        o,
      ),
    album: (items, o = {}) => send({ type: 'album', items, ...captionFields(o.caption) }, o),
    poll: (name, choices, o = {}) =>
      send({ type: 'poll', name, options: choices, ...pick(o, 'multiple') }, o),
  };
  return Object.assign((text: MessageText, o?: ReplyTextOptions) => sendText(text, o), shortcuts);
}

/** `{ [key]: valor }` só quando definido, para não mandar `undefined` explícito ao transport. */
function pick<T extends object, K extends keyof T>(source: T, key: K): Partial<Pick<T, K>> {
  const value = source[key];
  return value === undefined ? {} : ({ [key]: value } as Partial<Pick<T, K>>);
}
