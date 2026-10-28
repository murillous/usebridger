// Transport do Telegram sobre o grammY (ADR 0137). Recebe por long polling (`bot.start()`), que
// re-tenta sozinho as falhas transitórias: o `closed` só sai quando a queda é terminal (401, 409
// ou falha no boot), e quem decide reconectar é o `Bot` (ADR 0044, ADR 0064). A conversão dos
// updates fica em `normalize.ts`; a formatação, em `format.ts`.

import type {
  Capability,
  Chat,
  Contact,
  FormattedText,
  GroupMetadata,
  GroupParticipantAction,
  JsonValue,
  Logger,
  MediaInput,
  Message,
  MessageKey,
  OutgoingContent,
  SendOptions,
  TypingKind,
  Unsubscribe,
} from '@usebridger/core';
import { UnsupportedError } from '@usebridger/core';
import {
  type Interaction,
  type MediaLoader,
  type Transport,
  type TransportDeps,
  type TransportEventHandler,
  type TransportEventName,
  type TransportEvents,
  TypedEmitter,
} from '@usebridger/core/adapter';
import { type Bot, InputFile } from 'grammy';
import type { ChatMember, ReactionTypeEmoji, Message as TgMessage, Update } from 'grammy/types';
import { commandMenus } from './commands.ts';
import { call, expiredOr, toDisconnectReason } from './errors.ts';
import { renderHtml } from './format.ts';
import * as LOG from './log-events.ts';
import {
  type NormalizeEnv,
  parseChatId,
  senderOf,
  toChat,
  toContact,
  toMessage,
} from './normalize.ts';

/** Acesso ao Telegram que sai do processo; os testes trocam por um falso. */
export interface TelegramDriver {
  /** Um `Bot` novo do grammY, com o token já dentro. */
  makeBot(): Bot;
  /** Baixa o arquivo do `file_path` que o `getFile` devolveu. A URL leva o token: não a logue. */
  fetchFile(filePath: string): Promise<Response>;
}

/**
 * Updates pedidos ao `getUpdates`. `message_reaction` e `chat_member` só chegam se pedidos
 * explicitamente, e o `chat_member`, só a bot admin.
 */
const ALLOWED_UPDATES = [
  'message',
  'edited_message',
  'callback_query',
  'message_reaction',
  'my_chat_member',
  'chat_member',
] as const;

/**
 * Prefixo do ID da interação: o `callback_query.id` não é ID de mensagem, e o envio que a cita
 * não pode virar `reply_parameters` (ADR 0137).
 */
const INTERACTION_PREFIX = 'cb:';

/** Direitos dados no `promote`: os de moderação comuns de um admin de grupo. */
const ADMIN_RIGHTS = {
  can_manage_chat: true,
  can_delete_messages: true,
  can_restrict_members: true,
  can_invite_users: true,
  can_pin_messages: true,
} as const;

export class TelegramTransport implements Transport {
  readonly name = 'telegram';
  /**
   * O núcleo da Bot API. `send.album` e `polls` entram com as issues de álbum e de enquete
   * (ADR 0137); `groups.add` não existe para bot no Telegram (ADR 0055).
   */
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>([
    'actions',
    'groups',
    'groups.remove',
    'groups.promote',
    'mentions',
    'reactions',
    'typing',
    'send.text',
    'send.image',
    'send.video',
    'send.audio',
    'send.voice',
    'send.sticker',
    'send.document',
    'media.download',
    // O `file_id` vale entre restarts para o mesmo bot (ADR 0136).
    'media.ref',
    'message.edit',
    'message.delete',
    'quoted',
  ]);
  readonly limits = { text: 4096, caption: 1024 };
  /** 30 mensagens/s no total e cerca de 1/s por chat (ADR 0063). */
  readonly pacing = { globalIntervalMs: 34, chatIntervalMs: 1000 };

  readonly #driver: TelegramDriver;
  readonly #deps: TransportDeps;
  readonly #events: TypedEmitter<TransportEvents>;
  #bot: Bot | null = null;
  #self: Contact | null = null;
  /** Update de onde cada mensagem ou interação saiu, para o `raw()` (ADR 0062). */
  readonly #raws = new WeakMap<Message | Interaction, unknown>();
  /** O último menu enviado ao Telegram, para só chamar a API quando ele muda. */
  #menu: string | undefined;

  constructor(driver: TelegramDriver, deps: TransportDeps) {
    this.#driver = driver;
    this.#deps = deps;
    this.#events = new TypedEmitter<TransportEvents>((error, event) =>
      this.#log.event(LOG.handlerFailed, { err: error, eventName: event }),
    );
    deps.commands?.onChange(() => this.#syncCommands());
  }

  get self(): Contact | null {
    return this.#self;
  }

  /** O `Bot` do grammY da conexão atual, ou `null` sem conexão. */
  get native(): unknown {
    return this.#bot;
  }

  /** O `Update` de onde a mensagem ou o clique saiu; a citada devolve a `Message` da Bot API. */
  raw(source: Message | Interaction): unknown {
    return this.#raws.get(source);
  }

  get #log(): Logger {
    return this.#deps.log;
  }

  on<E extends TransportEventName>(event: E, handler: TransportEventHandler<E>): Unsubscribe {
    return this.#events.on(event, handler);
  }

  async connect(): Promise<void> {
    // Reconexão: o polling anterior já parou, mas pode seguir de pé se alguém chamou
    // `connect()` duas vezes.
    await this.disconnect();
    const bot = this.#driver.makeBot();
    this.#bot = bot;
    const current = (): boolean => this.#bot === bot;
    bot.use((ctx) => {
      if (current()) this.#onUpdate(ctx.update);
    });
    // Erro de conversão descarta só o update: relançar pararia o polling.
    bot.catch(({ error, ctx }) => {
      this.#log.event(LOG.updateFailed, { err: error, updateId: ctx.update.update_id });
    });
    this.#events.emit('connection.status', { status: 'connecting' });
    bot
      .start({
        allowed_updates: ALLOWED_UPDATES,
        onStart: (me) => {
          if (!current()) return;
          this.#self = toContact(me);
          this.#events.emit('connection.status', { status: 'open' });
          this.#syncCommands();
        },
      })
      .then(
        () => {
          // Só o `disconnect()` para o polling sem erro, e ele já tirou este bot de cena.
        },
        (error: unknown) => {
          if (!current()) return;
          this.#bot = null;
          const reason = toDisconnectReason(error);
          this.#events.emit('connection.status', { status: 'closed', reason, error });
        },
      );
  }

  async disconnect(): Promise<void> {
    const bot = this.#bot;
    if (bot === null) return;
    this.#bot = null;
    // O `stop()` cancela o `getUpdates` em andamento e confirma o offset no Telegram.
    await bot.stop().catch((error: unknown) => {
      this.#log.event(LOG.stopFailed, { err: error });
    });
  }

  #onUpdate(update: Update): void {
    if (update.message !== undefined) this.#onMessage(update, update.message, false);
    else if (update.edited_message !== undefined) {
      this.#onMessage(update, update.edited_message, true);
    } else if (update.callback_query !== undefined) this.#onCallback(update);
    else if (update.message_reaction !== undefined) this.#onReaction(update.message_reaction);
    else if (update.my_chat_member !== undefined) this.#onSelfMember(update.my_chat_member);
    else if (update.chat_member !== undefined) this.#onMember(update.chat_member);
  }

  #onMessage(update: Update, raw: TgMessage, edited: boolean): void {
    const message = toMessage(raw, this.#env(), { edited });
    if (message === null) {
      // Mensagem de serviço: só a troca de título tem evento no core.
      if (raw.new_chat_title !== undefined) {
        this.#events.emit('group.updated', { chat: toChat(raw.chat), title: raw.new_chat_title });
      }
      return;
    }
    this.#raws.set(message, update);
    if (message.quoted !== null && raw.reply_to_message !== undefined) {
      this.#raws.set(message.quoted, raw.reply_to_message);
    }
    this.#events.emit(edited ? 'message.edited' : 'message', message);
  }

  #onCallback(update: Update): void {
    const query = update.callback_query;
    if (query === undefined) return;
    // Confirma na hora, sem segurar o polling: o botão para de girar (ADR 0058).
    this.#connected()
      .api.answerCallbackQuery(query.id)
      .catch((error: unknown) => this.#log.event(LOG.callbackAnswerFailed, { err: error }));
    // Sem `data` (jogo) ou sem mensagem (modo inline), o clique não é de um botão nosso.
    if (query.data === undefined || query.message === undefined) return;
    const interaction: Interaction = {
      id: `${INTERACTION_PREFIX}${query.id}`,
      chat: toChat(query.message.chat, query.message),
      sender: toContact(query.from),
      actionId: query.data,
      timestamp: Date.now(),
    };
    this.#raws.set(interaction, update);
    this.#events.emit('interaction', interaction);
  }

  #onReaction(update: NonNullable<Update['message_reaction']>): void {
    const sender = senderOf({ from: update.user, sender_chat: update.actor_chat });
    if (sender === null) return;
    // O bot e cada pessoa têm no máximo uma reação de emoji; a personalizada não tem
    // equivalente no core e não vira evento.
    const reaction = update.new_reaction.find((r): r is ReactionTypeEmoji => r.type === 'emoji');
    if (reaction === undefined && update.new_reaction.length > 0) return;
    this.#events.emit('reaction', {
      // A Bot API não diz o tópico da mensagem reagida: vale o chat, e o `message_id` é único
      // nele (ADR 0054).
      chat: toChat(update.chat),
      messageId: String(update.message_id),
      sender,
      emoji: reaction?.emoji ?? null,
      fromMe: sender.id === this.#self?.id,
    });
  }

  #onSelfMember(update: NonNullable<Update['my_chat_member']>): void {
    if (update.chat.type === 'private') return;
    const was = isIn(update.old_chat_member);
    const is = isIn(update.new_chat_member);
    if (was === is) return;
    this.#events.emit(is ? 'group.joined' : 'group.left', { chat: toChat(update.chat) });
  }

  #onMember(update: NonNullable<Update['chat_member']>): void {
    const action = memberAction(update.old_chat_member, update.new_chat_member);
    if (action === null) return;
    this.#events.emit('group.participants', {
      chat: toChat(update.chat),
      action,
      participants: [toContact(update.new_chat_member.user)],
      actor: toContact(update.from),
    });
  }

  #env(): NormalizeEnv {
    return {
      self: this.#self,
      download: (fileId) => this.#download(fileId),
      stream: (fileId) => this.#stream(fileId),
    };
  }

  async #fetch(fileId: string): Promise<Response> {
    const file = await call(() => this.#connected().api.getFile(fileId));
    if (file.file_path === undefined) throw new Error('telegram: o getFile não devolveu caminho');
    const response = await this.#driver.fetchFile(file.file_path);
    // Sem a URL na mensagem: ela leva o token.
    if (!response.ok) throw new Error(`telegram: download do arquivo falhou (${response.status})`);
    return response;
  }

  async #download(fileId: string): Promise<Buffer> {
    return Buffer.from(await (await this.#fetch(fileId)).arrayBuffer());
  }

  async #stream(fileId: string): Promise<ReadableStream<Uint8Array>> {
    const body = (await this.#fetch(fileId)).body;
    if (body === null) throw new Error('telegram: download do arquivo sem corpo');
    return body;
  }

  async send(chatId: string, content: OutgoingContent, options?: SendOptions): Promise<MessageKey> {
    const api = this.#connected().api;
    const { chat_id, message_thread_id } = parseChatId(chatId);
    const quoted = options?.quoted;
    const other = {
      ...(message_thread_id !== undefined && { message_thread_id }),
      ...(quoted !== undefined &&
        !quoted.id.startsWith(INTERACTION_PREFIX) && {
          // A citada pode ter sido apagada: envia mesmo assim, sem a citação.
          reply_parameters: { message_id: Number(quoted.id), allow_sending_without_reply: true },
        }),
      ...(options?.actions !== undefined &&
        options.actions.length > 0 && {
          reply_markup: {
            inline_keyboard: options.actions.map((a) => [{ text: a.label, callback_data: a.id }]),
          },
        }),
    };
    const sent = await call((): Promise<TgMessage> => {
      switch (content.type) {
        case 'text':
          return content.formatted === undefined
            ? api.sendMessage(chat_id, content.text, other)
            : api.sendMessage(chat_id, renderHtml(content.formatted), {
                ...other,
                parse_mode: 'HTML',
              });
        case 'image':
          return api.sendPhoto(chat_id, input(content.media), { ...other, ...caption(content) });
        case 'video':
          return api.sendVideo(chat_id, input(content.media), { ...other, ...caption(content) });
        case 'audio':
          return api.sendAudio(chat_id, input(content.media), other);
        case 'voice':
          return api.sendVoice(chat_id, input(content.media), other);
        case 'sticker':
          return api.sendSticker(chat_id, input(content.media), other);
        case 'document':
          return api.sendDocument(chat_id, input(content.media, content.fileName), {
            ...other,
            ...caption(content),
          });
        case 'album':
          throw new UnsupportedError('send.album', this.name);
        case 'poll':
          throw new UnsupportedError('polls', this.name);
        case 'template':
          throw new UnsupportedError('send.template', this.name);
        default:
          throw new TypeError(
            `telegram: conteúdo desconhecido "${(content as { type: string }).type}"`,
          );
      }
    });
    return { chatId, id: String(sent.message_id), fromMe: true, senderId: null };
  }

  async react(key: MessageKey, emoji: string | null): Promise<void> {
    const api = this.#connected().api;
    const { chat_id } = parseChatId(key.chatId);
    // Lista vazia remove; emoji fora do conjunto do Telegram volta 400, e o `call` o marca
    // como permanente (ADR 0066).
    const reaction = emoji === null ? [] : [{ type: 'emoji', emoji } as ReactionTypeEmoji];
    await call(() => api.setMessageReaction(chat_id, Number(key.id), reaction));
  }

  async edit(key: MessageKey, text: string, formatted?: FormattedText): Promise<void> {
    const api = this.#connected().api;
    const { chat_id } = parseChatId(key.chatId);
    await call(() =>
      formatted === undefined
        ? api.editMessageText(chat_id, Number(key.id), text)
        : api.editMessageText(chat_id, Number(key.id), renderHtml(formatted), {
            parse_mode: 'HTML',
          }),
    );
  }

  async delete(key: MessageKey): Promise<void> {
    const api = this.#connected().api;
    const { chat_id } = parseChatId(key.chatId);
    await call(() => api.deleteMessage(chat_id, Number(key.id)));
  }

  async sendTyping(chatId: string, kind: TypingKind): Promise<void> {
    const api = this.#connected().api;
    const { chat_id, message_thread_id } = parseChatId(chatId);
    await call(() =>
      api.sendChatAction(chat_id, kind === 'voice' ? 'record_voice' : 'typing', {
        ...(message_thread_id !== undefined && { message_thread_id }),
      }),
    );
  }

  /** Sem `participants`: o Telegram não lista membros, só admins (ADR 0055). */
  async getGroupMetadata(groupId: string): Promise<GroupMetadata> {
    const api = this.#connected().api;
    const { chat_id } = parseChatId(groupId);
    const [chat, admins] = await call(() =>
      Promise.all([api.getChat(chat_id), api.getChatAdministrators(chat_id)]),
    );
    const owner = admins.find((m) => m.status === 'creator');
    return {
      id: groupId,
      title: chat.title ?? '',
      description: chat.description ?? null,
      ownerId: owner === undefined ? null : String(owner.user.id),
    };
  }

  async isChatAdmin(chat: Chat, contact: Contact): Promise<boolean> {
    if (!chat.isGroup) return false;
    const { chat_id } = parseChatId(chat.id);
    // Admin anônimo fala como o próprio grupo (`sender_chat`), e só admin pode fazê-lo.
    if (contact.id === String(chat_id)) return true;
    const api = this.#connected().api;
    const member = await call(() => api.getChatMember(chat_id, Number(contact.id)));
    return member.status === 'administrator' || member.status === 'creator';
  }

  async updateGroupParticipants(
    groupId: string,
    participantIds: readonly string[],
    action: GroupParticipantAction,
  ): Promise<void> {
    const api = this.#connected().api;
    const { chat_id } = parseChatId(groupId);
    for (const id of participantIds) {
      const user = Number(id);
      switch (action) {
        case 'remove':
          // Banir e desbanir tira a pessoa sem impedir que volte (ADR 0055).
          await call(() => api.banChatMember(chat_id, user));
          await call(() => api.unbanChatMember(chat_id, user, { only_if_banned: true }));
          break;
        case 'promote':
          await call(() => api.promoteChatMember(chat_id, user, ADMIN_RIGHTS));
          break;
        case 'demote':
          // Sem nenhum direito, a Bot API rebaixa.
          await call(() => api.promoteChatMember(chat_id, user));
          break;
        case 'add':
          throw new UnsupportedError('groups.add', this.name);
      }
    }
  }

  /** Mídia de uma referência guardada (ADR 0136): o `file_id`, baixado pela conexão do momento. */
  mediaFromRef(data: JsonValue): MediaLoader {
    const fileId =
      typeof data === 'object' && data !== null && !Array.isArray(data)
        ? (data as { readonly [key: string]: JsonValue })['fileId']
        : undefined;
    if (typeof fileId !== 'string' || fileId === '') {
      throw new TypeError('telegram: referência de mídia inválida');
    }
    return {
      download: () => this.#download(fileId).catch((e: unknown) => Promise.reject(expiredOr(e))),
      stream: () => this.#stream(fileId).catch((e: unknown) => Promise.reject(expiredOr(e))),
    };
  }

  #syncCommands(): void {
    const commands = this.#deps.commands;
    const bot = this.#bot;
    if (commands === undefined || bot === null) return;
    const menus = commandMenus(commands.list());
    const menu = JSON.stringify([menus.everyone, menus.admins]);
    if (menu === this.#menu) return;
    // Marcado antes da chamada: dois avisos seguidos não mandam o mesmo menu duas vezes.
    this.#menu = menu;
    for (const name of menus.skipped) this.#log.event(LOG.commandSkipped, { command: name });
    Promise.all([
      bot.api.setMyCommands([...menus.everyone]),
      bot.api.setMyCommands([...menus.admins], { scope: { type: 'all_chat_administrators' } }),
    ]).catch((error: unknown) => {
      // Falhou: a próxima mudança ou conexão tenta de novo.
      if (this.#menu === menu) this.#menu = undefined;
      this.#log.event(LOG.commandsSyncFailed, { err: error });
    });
  }

  /** Bot da conexão atual; sem ele, a ação falha na hora em vez de esperar. */
  #connected(): Bot {
    if (this.#bot === null) throw new Error('telegram: sem conexão');
    return this.#bot;
  }
}

/** Buffer sobe como arquivo; URL vai para o Telegram baixar, a não ser no documento com nome. */
function input(media: MediaInput, fileName?: string): InputFile | string {
  if (Buffer.isBuffer(media)) return new InputFile(media, fileName);
  // Pela URL direta, o Telegram usaria o nome do caminho: o grammY baixa e sobe com o nome.
  return fileName === undefined ? media.url : new InputFile(new URL(media.url), fileName);
}

function caption(content: {
  readonly caption?: string;
  readonly formattedCaption?: FormattedText;
}): { caption?: string; parse_mode?: 'HTML' } {
  if (content.formattedCaption !== undefined) {
    return { caption: renderHtml(content.formattedCaption), parse_mode: 'HTML' };
  }
  return content.caption === undefined ? {} : { caption: content.caption };
}

/** Membro do chat de verdade: o `restricted` diz no `is_member`. */
function isIn(member: ChatMember): boolean {
  if (member.status === 'restricted') return member.is_member;
  return member.status !== 'left' && member.status !== 'kicked';
}

function isAdmin(member: ChatMember): boolean {
  return member.status === 'administrator' || member.status === 'creator';
}

function memberAction(old: ChatMember, now: ChatMember): GroupParticipantAction | null {
  const was = isIn(old);
  const is = isIn(now);
  if (!was && is) return 'add';
  if (was && !is) return 'remove';
  if (!was) return null;
  if (!isAdmin(old) && isAdmin(now)) return 'promote';
  if (isAdmin(old) && !isAdmin(now)) return 'demote';
  return null;
}
