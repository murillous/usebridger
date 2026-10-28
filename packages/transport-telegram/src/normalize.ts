// Mensagem da Bot API → `Message` do core (ADR 0007). Funções puras: o download da mídia chega
// pelo `NormalizeEnv`, e nada aqui chama a API.

import type { Chat, Contact, Mention, Message } from '@usebridger/core';
import { createMessage, type MediaSource, type MessageInit } from '@usebridger/core/adapter';
import type {
  MessageEntity,
  Chat as TgChat,
  Message as TgMessage,
  User as TgUser,
} from 'grammy/types';

export interface NormalizeEnv {
  /** O próprio bot, depois do `getMe`; antes dele, `null`. */
  readonly self: Contact | null;
  /** Baixa um arquivo pelo `file_id`. */
  download(fileId: string): Promise<Buffer>;
  stream(fileId: string): Promise<ReadableStream<Uint8Array>>;
}

/**
 * Conteúdo que não tem tipo no core e chega como `unknown` (docs/transport.md, "Tipos sem
 * equivalente"). O resto sem conteúdo conhecido é mensagem de serviço (alguém entrou, título
 * mudou, mensagem fixada), que não vira `message`.
 */
const UNKNOWN_CONTENT = [
  'dice',
  'game',
  'story',
  'invoice',
  'paid_media',
  'checklist',
  'live_photo',
  'rich_message',
  'giveaway',
] as const;

/**
 * Compõe o `chat.id` com o tópico de fórum: a resposta precisa do
 * `message_thread_id`, ou cai no "General". `parseChatId` desfaz.
 */
export function chatIdOf(
  message: Pick<TgMessage, 'chat' | 'is_topic_message' | 'message_thread_id'>,
): string {
  return message.is_topic_message && message.message_thread_id !== undefined
    ? `${message.chat.id}/${message.message_thread_id}`
    : String(message.chat.id);
}

export interface ChatTarget {
  readonly chat_id: number;
  readonly message_thread_id?: number;
}

/** O alvo da Bot API de um `chat.id` composto por `chatIdOf`. Lança `TypeError` se não for. */
export function parseChatId(chatId: string): ChatTarget {
  const match = /^(-?\d+)(?:\/(\d+))?$/.exec(chatId);
  if (match === null) throw new TypeError(`telegram: chat inválido "${chatId}"`);
  const [, chat, thread] = match;
  return {
    chat_id: Number(chat),
    ...(thread !== undefined && { message_thread_id: Number(thread) }),
  };
}

export function toChat(
  chat: TgChat,
  message?: Pick<TgMessage, 'is_topic_message' | 'message_thread_id'>,
): Chat {
  const title = chat.title ?? undefined;
  if (message?.is_topic_message && message.message_thread_id !== undefined) {
    return {
      id: `${chat.id}/${message.message_thread_id}`,
      isGroup: true,
      kind: 'thread',
      parentId: String(chat.id),
      ...(title !== undefined && { title }),
    };
  }
  const kind = chat.type === 'private' ? 'dm' : chat.type === 'channel' ? 'channel' : 'group';
  return {
    id: String(chat.id),
    isGroup: kind !== 'dm',
    kind,
    ...(title !== undefined && { title }),
  };
}

export function toContact(user: TgUser): Contact {
  return {
    id: String(user.id),
    name: [user.first_name, user.last_name].filter(Boolean).join(' ') || null,
    phone: null,
    ...(user.username !== undefined && { username: user.username }),
    ...(user.is_bot && { isBot: true }),
  };
}

/** Post de canal ou admin anônimo: quem fala é o chat. */
function chatAsContact(chat: TgChat): Contact {
  return {
    id: String(chat.id),
    name: chat.title ?? null,
    phone: null,
    ...(chat.username !== undefined && { username: chat.username }),
  };
}

export function senderOf(message: Pick<TgMessage, 'from' | 'sender_chat'>): Contact | null {
  if (message.sender_chat !== undefined) return chatAsContact(message.sender_chat);
  return message.from === undefined ? null : toContact(message.from);
}

/**
 * Converte a mensagem. `null` para mensagem de serviço e para o que não tem remetente. A citada
 * vem sem a própria citada, como a Bot API a entrega.
 */
export function toMessage(
  message: TgMessage,
  env: NormalizeEnv,
  options: { readonly edited?: boolean } = {},
): Message | null {
  const sender = senderOf(message);
  if (sender === null) return null;
  const content = contentOf(message, env);
  if (content === null) return null;
  const text = message.text ?? message.caption ?? null;
  const entities = message.entities ?? message.caption_entities ?? [];
  const selfId = env.self?.id;
  // No tópico, toda mensagem responde à criação do tópico: isso não é citação.
  const reply = message.reply_to_message;
  const quotedRaw =
    reply !== undefined &&
    !(message.is_topic_message && reply.message_id === message.message_thread_id)
      ? reply
      : undefined;
  const init = {
    ...content,
    id: String(message.message_id),
    chat: toChat(message.chat, message),
    sender,
    text,
    timestamp: message.date * 1000,
    fromMe:
      selfId !== undefined && message.from?.id !== undefined && String(message.from.id) === selfId,
    quoted: quotedRaw === undefined ? null : toMessage(quotedRaw, env),
    mentions: text === null ? [] : mentionsOf(text, entities, env.self),
    isForwarded: message.forward_origin !== undefined,
    isEdited: options.edited ?? false,
  } as MessageInit;
  return createMessage(init);
}

type Content =
  | { readonly type: 'text' }
  | {
      readonly type: 'image' | 'video' | 'audio' | 'voice' | 'sticker';
      readonly media: MediaSource;
    }
  | { readonly type: 'document'; readonly media: MediaSource; readonly fileName: string | null }
  | {
      readonly type: 'location';
      readonly location: {
        readonly latitude: number;
        readonly longitude: number;
        readonly name: string | null;
        readonly address?: string;
      };
    }
  | { readonly type: 'contact'; readonly contacts: readonly { name: string; vcard: string }[] }
  | { readonly type: 'poll'; readonly poll: { name: string; options: readonly string[] } }
  | { readonly type: 'unknown' };

function contentOf(message: TgMessage, env: NormalizeEnv): Content | null {
  const file = (
    fileId: string,
    mimetype: string,
    size: number | undefined,
    fileName?: string,
  ): MediaSource => ({
    mimetype,
    size: size ?? null,
    ...(fileName !== undefined && { fileName }),
    download: () => env.download(fileId),
    stream: () => env.stream(fileId),
    // O `file_id` vale entre restarts para o mesmo bot (ADR 0136).
    ref: { fileId },
  });

  const photo = message.photo?.at(-1); // a maior resolução vem por último
  if (photo !== undefined) {
    return { type: 'image', media: file(photo.file_id, 'image/jpeg', photo.file_size) };
  }
  // A animação também traz `document`: ela vem antes, como vídeo (GIF vira `video`).
  const video = message.animation ?? message.video;
  if (video !== undefined) {
    const media = file(
      video.file_id,
      video.mime_type ?? 'video/mp4',
      video.file_size,
      video.file_name,
    );
    return { type: 'video', media };
  }
  if (message.video_note !== undefined) {
    const note = message.video_note;
    return { type: 'video', media: file(note.file_id, 'video/mp4', note.file_size) };
  }
  if (message.audio !== undefined) {
    const audio = message.audio;
    const media = file(
      audio.file_id,
      audio.mime_type ?? 'audio/mpeg',
      audio.file_size,
      audio.file_name,
    );
    return { type: 'audio', media };
  }
  if (message.voice !== undefined) {
    const voice = message.voice;
    return {
      type: 'voice',
      media: file(voice.file_id, voice.mime_type ?? 'audio/ogg', voice.file_size),
    };
  }
  if (message.sticker !== undefined) {
    const sticker = message.sticker;
    const mimetype = sticker.is_animated
      ? 'application/x-tgsticker'
      : sticker.is_video
        ? 'video/webm'
        : 'image/webp';
    return { type: 'sticker', media: file(sticker.file_id, mimetype, sticker.file_size) };
  }
  if (message.document !== undefined) {
    const doc = message.document;
    const media = file(
      doc.file_id,
      doc.mime_type ?? 'application/octet-stream',
      doc.file_size,
      doc.file_name,
    );
    return { type: 'document', media, fileName: doc.file_name ?? null };
  }
  // O `venue` também traz `location`: vem antes, com nome e endereço.
  if (message.venue !== undefined) {
    const { location, title, address } = message.venue;
    return {
      type: 'location',
      location: {
        latitude: location.latitude,
        longitude: location.longitude,
        name: title,
        address,
      },
    };
  }
  if (message.location !== undefined) {
    const { latitude, longitude } = message.location;
    return { type: 'location', location: { latitude, longitude, name: null } };
  }
  if (message.contact !== undefined) {
    const contact = message.contact;
    const name = [contact.first_name, contact.last_name].filter(Boolean).join(' ');
    const vcard =
      contact.vcard ??
      `BEGIN:VCARD\nVERSION:3.0\nFN:${name}\nTEL:${contact.phone_number}\nEND:VCARD`;
    return { type: 'contact', contacts: [{ name, vcard }] };
  }
  if (message.poll !== undefined) {
    const poll = message.poll;
    return {
      type: 'poll',
      poll: { name: poll.question, options: poll.options.map((o) => o.text) },
    };
  }
  if (message.text !== undefined) return { type: 'text' };
  if (UNKNOWN_CONTENT.some((key) => message[key] !== undefined)) return { type: 'unknown' };
  return null;
}

/**
 * Menções das entities. A `text_mention` traz o usuário; a `mention` (`@usuario`) só traz o
 * texto, e a Bot API não resolve `@usuario` em ID: só a do próprio bot entra.
 */
function mentionsOf(
  text: string,
  entities: readonly MessageEntity[],
  self: Contact | null,
): readonly Mention[] {
  const mentions: Mention[] = [];
  for (const entity of entities) {
    // Os offsets da Bot API são em UTF-16, como os índices de string do JS.
    const tag = text.slice(entity.offset, entity.offset + entity.length);
    if (entity.type === 'text_mention') {
      mentions.push({ ...toContact(entity.user), tag });
    } else if (
      entity.type === 'mention' &&
      self?.username !== undefined &&
      tag.toLowerCase() === `@${self.username.toLowerCase()}`
    ) {
      mentions.push({ ...self, tag });
    }
  }
  return mentions;
}
