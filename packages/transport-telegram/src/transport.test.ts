import {
  bold,
  type CommandInfo,
  type ConnectionStatus,
  createMemoryStorage,
  fmt,
  type Logger,
  MediaExpiredError,
  type Message,
  mention,
} from '@usebridger/core';
import type {
  Interaction,
  TransportDeps,
  TransportEventName,
  TransportEvents,
} from '@usebridger/core/adapter';
import type { Message as TgMessage, Update } from 'grammy/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BOT_USER, FakeTelegram, failure } from './fake-telegram.test-support.ts';
import { TelegramTransport } from './transport.ts';

const USER = { id: 7, is_bot: false, first_name: 'Ana', last_name: 'Lima', username: 'ana' };
const DM = { id: 7, type: 'private' as const, first_name: 'Ana' };
const GROUP = { id: -100123, type: 'supergroup' as const, title: 'Turma' };

const noop = (): undefined => undefined;

const transports: TelegramTransport[] = [];
afterEach(async () => {
  for (const t of transports.splice(0)) await t.disconnect();
});

function silentLogger(): Logger & { event: ReturnType<typeof vi.fn> } {
  const log = {
    level: 'trace',
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    event: vi.fn(),
    child: () => log,
  } as unknown as Logger & { event: ReturnType<typeof vi.fn> };
  return log;
}

function setup(commands?: readonly CommandInfo[]) {
  const fake = new FakeTelegram();
  const log = silentLogger();
  const listeners: (() => void)[] = [];
  const deps: TransportDeps = {
    session: 'default',
    auth: createMemoryStorage().authState('default'),
    log,
    ...(commands && {
      commands: {
        list: () => commands,
        onChange: (listener) => {
          listeners.push(() => void listener());
          return noop;
        },
      },
    }),
  };
  const transport = new TelegramTransport(fake.driver, deps);
  transports.push(transport);
  const statuses: ConnectionStatus[] = [];
  transport.on('connection.status', (status) => {
    statuses.push(status);
  });
  return {
    fake,
    log,
    transport,
    statuses,
    changeCommands: () => {
      for (const l of listeners) l();
    },
  };
}

async function connected(commands?: readonly CommandInfo[]) {
  const s = setup(commands);
  await s.transport.connect();
  await vi.waitFor(() => expect(s.statuses.at(-1)).toEqual({ status: 'open' }));
  return s;
}

function next<E extends TransportEventName>(
  transport: TelegramTransport,
  event: E,
): Promise<TransportEvents[E]> {
  return new Promise((resolve) => {
    const off = transport.on(event, (payload) => {
      off();
      resolve(payload);
    });
  });
}

let nextId = 1;
function tgMessage(fields: Record<string, unknown>): TgMessage {
  return {
    message_id: nextId++,
    date: 1_760_000_000,
    chat: DM,
    from: USER,
    ...fields,
  } as TgMessage;
}

describe('conexão', () => {
  it('abre com o getMe como self, emitindo connecting e open', async () => {
    const { transport, statuses } = await connected();
    expect(statuses).toEqual([{ status: 'connecting' }, { status: 'open' }]);
    expect(transport.self).toEqual({
      id: '42',
      name: 'Bot',
      phone: null,
      username: 'fake_bot',
      isBot: true,
    });
  });

  it('401 no boot fecha com auth-failed', async () => {
    const { fake, transport, statuses } = setup();
    fake.handlers.set('getMe', () => failure(401, 'Unauthorized'));
    await transport.connect();
    await vi.waitFor(() =>
      expect(statuses.at(-1)).toMatchObject({ status: 'closed', reason: 'auth-failed' }),
    );
  });

  it('409 no getUpdates (outra instância) fecha com replaced', async () => {
    const { fake, transport, statuses } = setup();
    fake.handlers.set('getUpdates', () => failure(409, 'Conflict: terminated by other getUpdates'));
    await transport.connect();
    await vi.waitFor(() =>
      expect(statuses.at(-1)).toMatchObject({ status: 'closed', reason: 'replaced' }),
    );
  });

  it('disconnect para o polling sem emitir closed e é idempotente', async () => {
    const { fake, transport, statuses } = await connected();
    await transport.disconnect();
    await transport.disconnect();
    expect(statuses.at(-1)).toEqual({ status: 'open' });
    expect(transport.native).toBeNull();
    // A confirmação do offset vem sem `timeout`.
    expect(fake.callsTo('getUpdates').some((p) => p['timeout'] === undefined)).toBe(true);
  });

  it('disconnect sem connect resolve', async () => {
    const { transport } = setup();
    await expect(transport.disconnect()).resolves.toBeUndefined();
  });

  it('sem conexão, o envio falha na hora', async () => {
    const { transport } = setup();
    await expect(transport.send('7', { type: 'text', text: 'oi' })).rejects.toThrow('sem conexão');
  });
});

describe('entrada', () => {
  it('texto em DM vira message, com o update no raw()', async () => {
    const { fake, transport } = await connected();
    const got = next(transport, 'message');
    fake.push({ message: tgMessage({ text: 'oi' }) });
    const message = await got;
    expect(message).toMatchObject({
      type: 'text',
      text: 'oi',
      chat: { id: '7', isGroup: false, kind: 'dm' },
      sender: { id: '7', name: 'Ana Lima', phone: null, username: 'ana' },
      fromMe: false,
      quoted: null,
    });
    expect((transport.raw(message) as Update).message?.text).toBe('oi');
  });

  it('a menção ao próprio bot entra em mentions; a de outro @usuario não', async () => {
    const { fake, transport } = await connected();
    const got = next(transport, 'message');
    fake.push({
      message: tgMessage({
        chat: GROUP,
        text: '@fake_bot e @outro',
        entities: [
          { type: 'mention', offset: 0, length: 9 },
          { type: 'mention', offset: 12, length: 6 },
        ],
      }),
    });
    const message = await got;
    expect(message.chat).toEqual({ id: '-100123', isGroup: true, kind: 'group', title: 'Turma' });
    expect(message.mentions).toEqual([{ ...transport.self, tag: '@fake_bot' }]);
  });

  it('text_mention traz o contato com o ID', async () => {
    const { fake, transport } = await connected();
    const got = next(transport, 'message');
    fake.push({
      message: tgMessage({
        text: 'oi Bia',
        entities: [
          {
            type: 'text_mention',
            offset: 3,
            length: 3,
            user: { id: 9, is_bot: false, first_name: 'Bia' },
          },
        ],
      }),
    });
    expect((await got).mentions).toEqual([{ id: '9', name: 'Bia', phone: null, tag: 'Bia' }]);
  });

  it('tópico de fórum compõe o chat.id, e a resposta à criação do tópico não é citação', async () => {
    const { fake, transport } = await connected();
    const got = next(transport, 'message');
    fake.push({
      message: tgMessage({
        chat: GROUP,
        text: 'no tópico',
        is_topic_message: true,
        message_thread_id: 5,
        reply_to_message: tgMessage({
          message_id: 5,
          chat: GROUP,
          forum_topic_created: { name: 'T', icon_color: 1 },
        }),
      }),
    });
    const message = await got;
    expect(message.chat).toMatchObject({ id: '-100123/5', kind: 'thread', parentId: '-100123' });
    expect(message.quoted).toBeNull();

    await transport.send(message.chat.id, { type: 'text', text: 'ok' });
    expect(fake.callsTo('sendMessage').at(-1)).toMatchObject({
      chat_id: -100123,
      message_thread_id: 5,
    });
  });

  it('resposta vira quoted, e o raw() da citada é a mensagem da Bot API', async () => {
    const { fake, transport } = await connected();
    const got = next(transport, 'message');
    const original = tgMessage({ text: 'original' });
    fake.push({ message: tgMessage({ text: 'resposta', reply_to_message: original }) });
    const message = await got;
    expect(message.quoted).toMatchObject({ id: String(original.message_id), text: 'original' });
    expect(transport.raw(message.quoted as Message)).toBe(
      (transport.raw(message) as Update).message?.reply_to_message,
    );
  });

  it('foto vira image, baixa pelo getFile e dá a referência do file_id', async () => {
    const { fake, transport } = await connected();
    fake.handlers.set('getFile', (p) => ({
      file_id: p['file_id'],
      file_unique_id: 'u',
      file_path: 'photos/a.jpg',
    }));
    fake.files.set('photos/a.jpg', Buffer.from('jpeg'));
    const got = next(transport, 'message');
    fake.push({
      message: tgMessage({
        caption: 'legenda',
        photo: [
          { file_id: 'small', file_unique_id: 's', width: 90, height: 90 },
          { file_id: 'big', file_unique_id: 'b', width: 800, height: 800, file_size: 4 },
        ],
      }),
    });
    const message = await got;
    if (!message.is('image')) throw new Error('esperava image');
    expect(message.text).toBe('legenda');
    expect(message.media).toMatchObject({ mimetype: 'image/jpeg', size: 4 });
    expect(await message.media.download()).toEqual(Buffer.from('jpeg'));
    expect(fake.callsTo('getFile')).toEqual([{ file_id: 'big' }]);

    const loader = transport.mediaFromRef({ fileId: 'big' });
    expect(await loader.download()).toEqual(Buffer.from('jpeg'));
  });

  it.each([
    [
      {
        sticker: {
          file_id: 'f',
          file_unique_id: 'u',
          type: 'regular',
          width: 1,
          height: 1,
          is_animated: false,
          is_video: false,
        },
      },
      'sticker',
      'image/webp',
    ],
    [
      {
        sticker: {
          file_id: 'f',
          file_unique_id: 'u',
          type: 'regular',
          width: 1,
          height: 1,
          is_animated: true,
          is_video: false,
        },
      },
      'sticker',
      'application/x-tgsticker',
    ],
    [{ voice: { file_id: 'f', file_unique_id: 'u', duration: 1 } }, 'voice', 'audio/ogg'],
    [
      { video_note: { file_id: 'f', file_unique_id: 'u', length: 1, duration: 1 } },
      'video',
      'video/mp4',
    ],
    [
      {
        animation: {
          file_id: 'f',
          file_unique_id: 'u',
          width: 1,
          height: 1,
          duration: 1,
          mime_type: 'video/mp4',
        },
        document: { file_id: 'f', file_unique_id: 'u', mime_type: 'video/mp4' },
      },
      'video',
      'video/mp4',
    ],
    [
      {
        document: {
          file_id: 'f',
          file_unique_id: 'u',
          file_name: 'a.pdf',
          mime_type: 'application/pdf',
        },
      },
      'document',
      'application/pdf',
    ],
  ])('mídia %# vira %s com %s', async (fields, type, mimetype) => {
    const { fake, transport } = await connected();
    const got = next(transport, 'message');
    fake.push({ message: tgMessage(fields) });
    const message = await got;
    expect(message.type).toBe(type);
    expect(message.attachments[0]?.mimetype).toBe(mimetype);
  });

  it('venue vira location com nome e endereço; dado vira unknown', async () => {
    const { fake, transport } = await connected();
    const got = next(transport, 'message');
    fake.push({
      message: tgMessage({
        location: { latitude: 1, longitude: 2 },
        venue: { location: { latitude: 1, longitude: 2 }, title: 'Praça', address: 'Rua A' },
      }),
    });
    expect(await got).toMatchObject({
      type: 'location',
      location: { latitude: 1, longitude: 2, name: 'Praça', address: 'Rua A' },
    });
    const dice = next(transport, 'message');
    fake.push({ message: tgMessage({ dice: { emoji: '🎲', value: 3 } }) });
    expect((await dice).type).toBe('unknown');
  });

  it('mensagem de serviço não vira message; título novo vira group.updated', async () => {
    const { fake, transport } = await connected();
    const messages: Message[] = [];
    transport.on('message', (m) => {
      messages.push(m);
    });
    const updated = next(transport, 'group.updated');
    fake.push({ message: tgMessage({ chat: GROUP, new_chat_members: [USER] }) });
    fake.push({ message: tgMessage({ chat: GROUP, new_chat_title: 'Nova' }) });
    expect(await updated).toEqual({
      chat: { id: '-100123', isGroup: true, kind: 'group', title: 'Turma' },
      title: 'Nova',
    });
    expect(messages).toEqual([]);
  });

  it('admin anônimo fala como o grupo (sender_chat)', async () => {
    const { fake, transport } = await connected();
    const got = next(transport, 'message');
    fake.push({ message: tgMessage({ chat: GROUP, sender_chat: GROUP, text: 'aviso' }) });
    expect((await got).sender).toEqual({ id: '-100123', name: 'Turma', phone: null });
  });

  it('edited_message vira message.edited com isEdited', async () => {
    const { fake, transport } = await connected();
    const got = next(transport, 'message.edited');
    fake.push({ edited_message: tgMessage({ text: 'corrigido', edit_date: 1_760_000_100 }) });
    expect(await got).toMatchObject({ text: 'corrigido', isEdited: true });
  });

  it('clique confirma na hora e vira interaction com o prefixo cb:', async () => {
    const { fake, transport } = await connected();
    const got = next(transport, 'interaction');
    fake.push({
      callback_query: {
        id: '999',
        from: USER,
        chat_instance: 'x',
        data: 'act1',
        message: tgMessage({ text: 'menu', from: BOT_USER }),
      },
    });
    const interaction = await got;
    expect(interaction).toMatchObject({
      id: 'cb:999',
      actionId: 'act1',
      chat: { id: '7' },
      sender: { id: '7' },
    });
    expect(fake.callsTo('answerCallbackQuery')).toEqual([{ callback_query_id: '999' }]);
    expect((transport.raw(interaction as Interaction) as Update).callback_query?.id).toBe('999');
  });

  it('reação de emoji vira reaction; a removida vem com null', async () => {
    const { fake, transport } = await connected();
    const got = next(transport, 'reaction');
    fake.push({
      message_reaction: {
        chat: GROUP,
        message_id: 10,
        user: USER,
        date: 1,
        old_reaction: [],
        new_reaction: [{ type: 'emoji', emoji: '👍' }],
      },
    });
    expect(await got).toMatchObject({
      messageId: '10',
      emoji: '👍',
      sender: { id: '7' },
      fromMe: false,
    });
    const removed = next(transport, 'reaction');
    fake.push({
      message_reaction: {
        chat: GROUP,
        message_id: 10,
        user: USER,
        date: 2,
        old_reaction: [{ type: 'emoji', emoji: '👍' }],
        new_reaction: [],
      },
    });
    expect((await removed).emoji).toBeNull();
  });

  it('my_chat_member vira group.joined/left; chat_member vira group.participants', async () => {
    const { fake, transport } = await connected();
    const joined = next(transport, 'group.joined');
    const member = (status: string, extra = {}) => ({ status, user: USER, ...extra });
    fake.push({
      my_chat_member: {
        chat: GROUP,
        from: USER,
        date: 1,
        old_chat_member: { status: 'left', user: BOT_USER },
        new_chat_member: { status: 'member', user: BOT_USER },
      },
    });
    expect((await joined).chat.id).toBe('-100123');

    const participants = next(transport, 'group.participants');
    fake.push({
      chat_member: {
        chat: GROUP,
        from: { id: 8, is_bot: false, first_name: 'Dono' },
        date: 1,
        old_chat_member: member('member'),
        new_chat_member: member('administrator', { can_be_edited: false }),
      },
    });
    expect(await participants).toMatchObject({
      action: 'promote',
      participants: [{ id: '7' }],
      actor: { id: '8' },
    });
  });
});

describe('envio', () => {
  it('texto cru vai sem parse_mode; a árvore vai em HTML com escape', async () => {
    const { fake, transport } = await connected();
    const key = await transport.send('7', { type: 'text', text: 'a < b' });
    expect(key).toEqual({ chatId: '7', id: expect.any(String), fromMe: true, senderId: null });
    expect(fake.callsTo('sendMessage').at(-1)).toEqual({ chat_id: 7, text: 'a < b' });

    const formatted = fmt`${bold('oi')} ${mention({ id: '9', name: 'Bia', phone: null })} <x>`;
    await transport.send('7', { type: 'text', text: 'oi @Bia <x>', formatted });
    expect(fake.callsTo('sendMessage').at(-1)).toEqual({
      chat_id: 7,
      text: '<b>oi</b> <a href="tg://user?id=9">Bia</a> &lt;x&gt;',
      parse_mode: 'HTML',
    });
  });

  it('cita com reply_parameters, mas não a mensagem de um clique', async () => {
    const { fake, transport } = await connected();
    const got = next(transport, 'message');
    fake.push({ message: tgMessage({ text: 'oi' }) });
    const message = await got;
    await transport.send('7', { type: 'text', text: 'r' }, { quoted: message });
    expect(fake.callsTo('sendMessage').at(-1)?.['reply_parameters']).toEqual({
      message_id: Number(message.id),
      allow_sending_without_reply: true,
    });
    await transport.send(
      '7',
      { type: 'text', text: 'r' },
      { quoted: { ...message, id: 'cb:999' } },
    );
    expect(fake.callsTo('sendMessage').at(-1)).not.toHaveProperty('reply_parameters');
  });

  it('botões viram teclado inline, um por linha', async () => {
    const { fake, transport } = await connected();
    await transport.send(
      '7',
      { type: 'text', text: 'Escolha:' },
      {
        actions: [
          { id: 'a', label: 'Ping' },
          { id: 'b', label: 'Eco' },
        ],
      },
    );
    expect(fake.callsTo('sendMessage').at(-1)?.['reply_markup']).toEqual({
      inline_keyboard: [
        [{ text: 'Ping', callback_data: 'a' }],
        [{ text: 'Eco', callback_data: 'b' }],
      ],
    });
  });

  it('mídia: URL vai direto, legenda formatada em HTML', async () => {
    const { fake, transport } = await connected();
    await transport.send('7', {
      type: 'image',
      media: { url: 'https://x/y.jpg' },
      caption: 'c',
      formattedCaption: fmt`${bold('c')}`,
    });
    expect(fake.callsTo('sendPhoto').at(-1)).toEqual({
      chat_id: 7,
      photo: 'https://x/y.jpg',
      caption: '<b>c</b>',
      parse_mode: 'HTML',
    });
  });

  it('429 traz retryAfterMs; 400 é permanente; queda de rede segue sem campo', async () => {
    const { fake, transport } = await connected();
    fake.handlers.set('sendMessage', () => failure(429, 'Too Many Requests', { retry_after: 3 }));
    await expect(transport.send('7', { type: 'text', text: 'x' })).rejects.toMatchObject({
      retryAfterMs: 3000,
    });
    fake.handlers.set('sendMessage', () => failure(400, 'Bad Request: chat not found'));
    await expect(transport.send('7', { type: 'text', text: 'x' })).rejects.toMatchObject({
      retryable: false,
    });
    fake.handlers.set('sendMessage', () => {
      throw new Error('ECONNRESET');
    });
    const error = await transport.send('7', { type: 'text', text: 'x' }).catch((e: unknown) => e);
    expect(error).not.toHaveProperty('retryable');
  });

  it('react, edit, delete e typing chamam a Bot API', async () => {
    const { fake, transport } = await connected();
    const key = { chatId: '-100123/5', id: '10', fromMe: true, senderId: null };
    await transport.react(key, '👍');
    await transport.react(key, null);
    await transport.edit(key, 'novo');
    await transport.delete(key);
    await transport.sendTyping('-100123/5', 'voice');
    expect(fake.callsTo('setMessageReaction')).toEqual([
      { chat_id: -100123, message_id: 10, reaction: [{ type: 'emoji', emoji: '👍' }] },
      { chat_id: -100123, message_id: 10, reaction: [] },
    ]);
    expect(fake.callsTo('editMessageText')).toEqual([
      { chat_id: -100123, message_id: 10, text: 'novo' },
    ]);
    expect(fake.callsTo('deleteMessage')).toEqual([{ chat_id: -100123, message_id: 10 }]);
    expect(fake.callsTo('sendChatAction')).toEqual([
      { chat_id: -100123, action: 'record_voice', message_thread_id: 5 },
    ]);
  });
});

describe('grupos', () => {
  it('metadados sem participants, com o dono dos admins', async () => {
    const { fake, transport } = await connected();
    fake.handlers.set('getChat', () => ({ ...GROUP, description: 'desc' }));
    fake.handlers.set('getChatAdministrators', () => [
      { status: 'creator', user: USER, is_anonymous: false },
    ]);
    expect(await transport.getGroupMetadata('-100123')).toEqual({
      id: '-100123',
      title: 'Turma',
      description: 'desc',
      ownerId: '7',
    });
  });

  it('isChatAdmin pelo getChatMember; admin anônimo é o próprio grupo', async () => {
    const { fake, transport } = await connected();
    fake.handlers.set('getChatMember', () => ({ status: 'administrator', user: USER }));
    const chat = { id: '-100123', isGroup: true };
    expect(await transport.isChatAdmin(chat, { id: '7', name: null, phone: null })).toBe(true);
    expect(await transport.isChatAdmin(chat, { id: '-100123', name: null, phone: null })).toBe(
      true,
    );
    expect(fake.callsTo('getChatMember')).toHaveLength(1);
  });

  it('remove bane e desbane; demote promove sem direitos', async () => {
    const { fake, transport } = await connected();
    await transport.updateGroupParticipants('-100123', ['7'], 'remove');
    await transport.updateGroupParticipants('-100123', ['7'], 'demote');
    expect(fake.callsTo('banChatMember')).toEqual([{ chat_id: -100123, user_id: 7 }]);
    expect(fake.callsTo('unbanChatMember')).toEqual([
      { chat_id: -100123, user_id: 7, only_if_banned: true },
    ]);
    expect(fake.callsTo('promoteChatMember')).toEqual([{ chat_id: -100123, user_id: 7 }]);
  });
});

describe('referência de mídia', () => {
  it('dado malformado lança TypeError', async () => {
    const { transport } = await connected();
    expect(() => transport.mediaFromRef({ outro: 1 })).toThrow(TypeError);
    expect(() => transport.mediaFromRef('x')).toThrow(TypeError);
  });

  it('file_id que o Telegram não reconhece rejeita com MediaExpiredError', async () => {
    const { fake, transport } = await connected();
    fake.handlers.set('getFile', () => failure(400, 'Bad Request: wrong file_id specified'));
    await expect(transport.mediaFromRef({ fileId: 'velho' }).download()).rejects.toBeInstanceOf(
      MediaExpiredError,
    );
  });
});

describe('menu de comandos', () => {
  const info = (name: string, role: CommandInfo['role']): CommandInfo => ({
    plugin: 'p',
    name,
    aliases: [],
    description: null,
    role,
  });

  it('registra no open e só chama a API de novo quando a lista muda', async () => {
    const list = [info('ping', 'everyone'), info('ban', 'group-admin'), info('Ruim', 'everyone')];
    const { fake, changeCommands } = await connected(list);
    await vi.waitFor(() => expect(fake.callsTo('setMyCommands')).toHaveLength(2));
    expect(fake.callsTo('setMyCommands')).toEqual([
      { commands: [{ command: 'ping', description: 'ping' }] },
      {
        commands: [
          { command: 'ping', description: 'ping' },
          { command: 'ban', description: 'ban' },
        ],
        scope: { type: 'all_chat_administrators' },
      },
    ]);
    changeCommands();
    expect(fake.callsTo('setMyCommands')).toHaveLength(2);
  });
});

describe('álbum no envio', () => {
  const photo = (url: string) => ({ type: 'image' as const, media: { url } });
  const doc = (url: string, fileName: string) => ({
    type: 'document' as const,
    media: { url },
    fileName,
    mimetype: 'application/pdf',
  });

  it('declara send.album e o limite de dez itens', () => {
    const { transport } = setup();
    expect(transport.capabilities.has('send.album')).toBe(true);
    expect(transport.limits.album).toBe(10);
  });

  it('foto e vídeo vão num sendMediaGroup, com a legenda no primeiro item', async () => {
    const { fake, transport } = await connected();
    const key = await transport.send(
      '-100123/5',
      {
        type: 'album',
        items: [photo('https://x/a.jpg'), { type: 'video', media: { url: 'https://x/b.mp4' } }],
        caption: 'c',
        formattedCaption: fmt`${bold('c')}`,
      },
      { quoted: { id: '9' } as Message },
    );
    expect(fake.callsTo('sendMediaGroup')).toEqual([
      {
        chat_id: -100123,
        message_thread_id: 5,
        reply_parameters: { message_id: 9, allow_sending_without_reply: true },
        media: [
          { type: 'photo', media: 'https://x/a.jpg', caption: '<b>c</b>', parse_mode: 'HTML' },
          { type: 'video', media: 'https://x/b.mp4' },
        ],
      },
    ]);
    expect(key).toEqual({ chatId: '-100123/5', id: '1000', fromMe: true, senderId: null });
  });

  it('documento e foto viram dois álbuns: legenda e citação no primeiro, chave do primeiro', async () => {
    const { fake, transport } = await connected();
    const key = await transport.send(
      '7',
      {
        type: 'album',
        items: [
          photo('https://x/1.jpg'),
          doc('https://x/a.pdf', 'a.pdf'),
          photo('https://x/2.jpg'),
        ],
        caption: 'c',
      },
      { quoted: { id: '9' } as Message },
    );
    const sends = fake.calls.filter((c) => c.method.startsWith('send'));
    expect(sends.map((c) => c.method)).toEqual(['sendMediaGroup', 'sendDocument']);
    expect(sends[0]?.payload).toEqual({
      chat_id: 7,
      reply_parameters: { message_id: 9, allow_sending_without_reply: true },
      media: [
        { type: 'photo', media: 'https://x/1.jpg', caption: 'c' },
        { type: 'photo', media: 'https://x/2.jpg' },
      ],
    });
    // O documento sozinho sai como mensagem comum, sem legenda nem citação.
    expect(sends[1]?.payload).toMatchObject({ chat_id: 7 });
    expect(sends[1]?.payload).not.toHaveProperty('caption');
    expect(sends[1]?.payload).not.toHaveProperty('reply_parameters');
    expect(key.id).toBe('1000');
  });

  it('começando por documento, o álbum de documentos vai primeiro e leva a legenda', async () => {
    const { fake, transport } = await connected();
    await transport.send('7', {
      type: 'album',
      items: [
        doc('https://x/a.pdf', 'a.pdf'),
        photo('https://x/1.jpg'),
        doc('https://x/b.pdf', 'b.pdf'),
      ],
      caption: 'c',
    });
    const [group] = fake.callsTo('sendMediaGroup');
    expect(group?.['media']).toMatchObject([
      { type: 'document', caption: 'c' },
      { type: 'document' },
    ]);
    expect(fake.callsTo('sendPhoto')).toHaveLength(1);
    expect(fake.callsTo('sendPhoto')[0]).not.toHaveProperty('caption');
  });

  it('o erro do segundo álbum sobe com a classificação da API', async () => {
    const { fake, transport } = await connected();
    fake.handlers.set('sendDocument', () => failure(400, 'Bad Request: wrong file'));
    await expect(
      transport.send('7', {
        type: 'album',
        items: [
          photo('https://x/1.jpg'),
          photo('https://x/2.jpg'),
          doc('https://x/a.pdf', 'a.pdf'),
        ],
      }),
    ).rejects.toMatchObject({ retryable: false });
  });
});

describe('álbum no envio: retry, tópico e botões', () => {
  const photo = (url: string) => ({ type: 'image' as const, media: { url } });
  const pdf = {
    type: 'document' as const,
    media: { url: 'https://x/a.pdf' },
    fileName: 'a.pdf',
    mimetype: 'application/pdf',
  };

  it('429 no segundo envio: a nova tentativa com o mesmo content não reenvia o primeiro', async () => {
    const { fake, transport } = await connected();
    let failed = false;
    fake.handlers.set('sendDocument', () => {
      if (failed) return { message_id: 2000, date: 1, chat: DM, text: '' };
      failed = true;
      return failure(429, 'Too Many Requests', { retry_after: 1 });
    });
    // A fila re-tenta com o mesmo objeto: o teste faz o mesmo.
    const content = {
      type: 'album' as const,
      items: [photo('https://x/1.jpg'), photo('https://x/2.jpg'), pdf],
    };
    await expect(transport.send('7', content)).rejects.toMatchObject({ retryAfterMs: 1000 });
    const key = await transport.send('7', content);
    expect(fake.callsTo('sendMediaGroup')).toHaveLength(1);
    expect(fake.callsTo('sendDocument')).toHaveLength(2);
    expect(key.id).toBe('1000');
    // Concluído, a chave guardada é esquecida: um novo envio do mesmo objeto sai de novo.
    await transport.send('7', content);
    expect(fake.callsTo('sendMediaGroup')).toHaveLength(2);
  });

  it('o tópico de fórum vai nos dois envios', async () => {
    const { fake, transport } = await connected();
    await transport.send('-100123/5', {
      type: 'album',
      items: [photo('https://x/1.jpg'), photo('https://x/2.jpg'), pdf],
    });
    expect(fake.callsTo('sendMediaGroup')[0]).toMatchObject({ message_thread_id: 5 });
    expect(fake.callsTo('sendDocument')[0]).toMatchObject({ message_thread_id: 5 });
  });

  it('álbum com botões é recusado, sem enviar nada e sem re-tentativa', async () => {
    const { fake, transport } = await connected();
    const error = await transport
      .send(
        '7',
        { type: 'album', items: [photo('https://x/1.jpg'), photo('https://x/2.jpg')] },
        { actions: [{ id: 'a', label: 'A' }] },
      )
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ retryable: false });
    expect(fake.callsTo('sendMediaGroup')).toHaveLength(0);
  });
});

describe('álbum na entrada', () => {
  const photoUpdate = (groupId: string, fileId: string, fields: Record<string, unknown> = {}) => ({
    message: tgMessage({
      media_group_id: groupId,
      photo: [{ file_id: fileId, file_unique_id: fileId, width: 9, height: 9 }],
      ...fields,
    }),
  });

  it('junta os updates do mesmo media_group_id numa message só, com a legenda e os anexos', async () => {
    const { fake, transport } = await connected();
    const messages: Message[] = [];
    transport.on('message', (m) => {
      messages.push(m);
    });
    const first = photoUpdate('g1', 'a');
    fake.push(first);
    fake.push({
      message: tgMessage({
        media_group_id: 'g1',
        document: {
          file_id: 'd',
          file_unique_id: 'd',
          file_name: 'n.pdf',
          mime_type: 'application/pdf',
        },
      }),
    });
    fake.push(photoUpdate('g1', 'c', { caption: 'legenda' }));
    // Outro grupo não se mistura.
    fake.push(photoUpdate('g2', 'x'));
    await vi.waitFor(() => expect(messages).toHaveLength(2), { timeout: 2000 });
    const message = messages.find((m) => m.attachments.length === 3);
    if (message === undefined) throw new Error('esperava o álbum de três anexos');
    expect(message.type).toBe('image');
    expect(message.id).toBe(String(first.message.message_id));
    expect(message.text).toBe('legenda');
    expect(message.attachments.map((m) => m.mimetype)).toEqual([
      'image/jpeg',
      'application/pdf',
      'image/jpeg',
    ]);
    expect(message.attachments[0]).toBe(message.is('image') ? message.media : undefined);
    expect(message.attachments[1]?.fileName).toBe('n.pdf');
    expect(transport.raw(message)).toMatchObject({ update_id: 1 });
    expect(messages.find((m) => m !== message)?.attachments).toHaveLength(1);
  });

  it('a janela conta desde o último update: um update tardio ainda entra no álbum', async () => {
    const { fake, transport } = await connected();
    const messages: Message[] = [];
    transport.on('message', (m) => {
      messages.push(m);
    });
    // Três updates a ~350 ms um do outro: cada um dentro da janela de 500 ms do anterior, mas o
    // último chega 700 ms depois do primeiro. Contada desde o primeiro, sairiam dois álbuns.
    fake.push(photoUpdate('g', 'a'));
    await new Promise((resolve) => setTimeout(resolve, 350));
    fake.push(photoUpdate('g', 'b'));
    await new Promise((resolve) => setTimeout(resolve, 350));
    fake.push(photoUpdate('g', 'c'));
    await vi.waitFor(() => expect(messages).toHaveLength(1), { timeout: 2000 });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(messages).toHaveLength(1);
    expect(messages[0]?.attachments).toHaveLength(3);
  });

  it('edição de item do álbum não é juntada: sai como message.edited', async () => {
    const { fake, transport } = await connected();
    const got = next(transport, 'message.edited');
    fake.push({ edited_message: photoUpdate('g', 'a').message });
    expect((await got).isEdited).toBe(true);
  });

  it('queda terminal com álbum pendente descarta o álbum e nada é emitido', async () => {
    const { fake, transport, statuses } = await connected();
    const messages: Message[] = [];
    transport.on('message', (m) => {
      messages.push(m);
    });
    const polls = fake.callsTo('getUpdates').length;
    fake.push(photoUpdate('g', 'a'));
    await vi.waitFor(() => expect(fake.callsTo('getUpdates').length).toBeGreaterThan(polls), {
      timeout: 2000,
    });
    // O poll pendurado já passou pelo handler: o texto o solta, e o próximo getUpdates leva o 409.
    fake.handlers.set('getUpdates', () => failure(409, 'Conflict: terminated by other getUpdates'));
    fake.push({ message: tgMessage({ text: 'solta o poll' }) });
    await vi.waitFor(
      () => expect(statuses.at(-1)).toMatchObject({ status: 'closed', reason: 'replaced' }),
      { timeout: 2000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(messages.filter((m) => m.attachments.length > 0)).toEqual([]);
  });

  it('disconnect com álbum pendente cancela o timer e nada é emitido', async () => {
    const { fake, transport } = await connected();
    const emitted = vi.fn();
    transport.on('message', emitted);
    const polls = fake.callsTo('getUpdates').length;
    fake.push(photoUpdate('g', 'a'));
    // O grammY só pede o próximo lote depois de tratar o update: ele já está no buffer.
    await vi.waitFor(() => expect(fake.callsTo('getUpdates').length).toBeGreaterThan(polls));
    await transport.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(emitted).not.toHaveBeenCalled();
  });
});

describe('enquetes', () => {
  /** Resposta do `sendPoll`: o Telegram devolve a mensagem com a enquete dentro. */
  function answerPolls(fake: FakeTelegram, pollId: string, messageId = 500, chat = GROUP): void {
    fake.handlers.set('sendPoll', () => ({
      message_id: messageId,
      date: 1_760_000_000,
      chat,
      poll: { id: pollId },
    }));
  }

  it('declara polls e pede o poll_answer ao getUpdates', async () => {
    const { fake, transport } = await connected();
    expect(transport.capabilities.has('polls')).toBe(true);
    const polling = fake.callsTo('getUpdates').find((p) => p['timeout'] !== undefined);
    expect(polling?.['allowed_updates']).toContain('poll_answer');
  });

  it('envia enquete não anônima; multiple vira allows_multiple_answers', async () => {
    const { fake, transport } = await connected();
    answerPolls(fake, 'p1');
    const key = await transport.send('-100123/5', {
      type: 'poll',
      name: 'Almoço?',
      options: ['Sim', 'Não'],
      multiple: true,
    });
    await transport.send('-100123', { type: 'poll', name: 'Outra', options: ['A', 'B'] });
    expect(key).toMatchObject({ chatId: '-100123/5', id: '500', fromMe: true });
    const [first, second] = fake.callsTo('sendPoll');
    expect(first).toEqual({
      chat_id: -100123,
      message_thread_id: 5,
      question: 'Almoço?',
      options: [{ text: 'Sim' }, { text: 'Não' }],
      is_anonymous: false,
      allows_multiple_answers: true,
    });
    expect(second).toMatchObject({ is_anonymous: false, allows_multiple_answers: false });
  });

  it('poll_answer vira poll.vote com o chat e a mensagem da enquete enviada', async () => {
    const { fake, transport } = await connected();
    answerPolls(fake, 'p1', 500);
    await transport.send('-100123', { type: 'poll', name: 'Q', options: ['A', 'B', 'C'] });
    const got = next(transport, 'poll.vote');
    fake.push({ poll_answer: { poll_id: 'p1', user: USER, option_ids: [2, 0] } });
    expect(await got).toEqual({
      chat: { id: '-100123', isGroup: true, kind: 'group', title: 'Turma' },
      messageId: '500',
      sender: expect.objectContaining({ id: '7' }),
      options: [0, 2],
      fromMe: false,
    });
  });

  it('voto retirado chega com options vazio', async () => {
    const { fake, transport } = await connected();
    answerPolls(fake, 'p1');
    await transport.send('-100123', { type: 'poll', name: 'Q', options: ['A', 'B'] });
    const got = next(transport, 'poll.vote');
    fake.push({ poll_answer: { poll_id: 'p1', user: USER, option_ids: [] } });
    expect((await got).options).toEqual([]);
  });

  it('voto de enquete desconhecida (antes do restart) é descartado com log', async () => {
    const { fake, transport, log } = await connected();
    const votes: unknown[] = [];
    transport.on('poll.vote', (v) => {
      votes.push(v);
    });
    // O voto desconhecido vem primeiro; a reação seguinte prova que o update foi consumido.
    fake.push({ poll_answer: { poll_id: 'velha', user: USER, option_ids: [1] } });
    const reaction = next(transport, 'reaction');
    fake.push({
      message_reaction: {
        chat: GROUP,
        message_id: 1,
        user: USER,
        date: 1,
        old_reaction: [],
        new_reaction: [{ type: 'emoji', emoji: '👍' }],
      },
    });
    await reaction;
    expect(votes).toEqual([]);
    expect(log.event).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'telegram.poll.vote-unknown' }),
      expect.objectContaining({ pollId: 'velha' }),
    );
  });
});

describe('enquetes: limite e voto de chat', () => {
  it('guarda no máximo 1000 enquetes: a mais antiga sai primeiro', async () => {
    const { fake, transport, log } = await connected();
    let n = 0;
    fake.handlers.set('sendPoll', () => {
      n += 1;
      return {
        message_id: n,
        date: 1_760_000_000,
        chat: GROUP,
        poll: { id: `p${n}` },
      };
    });
    for (let i = 0; i < 1001; i++) {
      await transport.send('-100123', { type: 'poll', name: 'Q', options: ['A', 'B'] });
    }
    const got = next(transport, 'poll.vote');
    fake.push({ poll_answer: { poll_id: 'p1', user: USER, option_ids: [0] } });
    fake.push({ poll_answer: { poll_id: 'p1001', user: USER, option_ids: [1] } });
    const vote = await got;
    expect(vote).toMatchObject({ messageId: '1001', options: [1] });
    expect(log.event).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'telegram.poll.vote-unknown' }),
      expect.objectContaining({ pollId: 'p1' }),
    );
  }, 30_000);

  it('voto de voter_chat vem com o chat como sender', async () => {
    const { fake, transport } = await connected();
    fake.handlers.set('sendPoll', () => ({
      message_id: 9,
      date: 1_760_000_000,
      chat: GROUP,
      poll: { id: 'pv' },
    }));
    await transport.send('-100123', { type: 'poll', name: 'Q', options: ['A', 'B'] });
    const got = next(transport, 'poll.vote');
    fake.push({
      poll_answer: {
        poll_id: 'pv',
        voter_chat: { id: -1009, type: 'channel', title: 'Canal' },
        option_ids: [0],
      },
    });
    expect((await got).sender).toMatchObject({ id: '-1009', name: 'Canal' });
  });
});
