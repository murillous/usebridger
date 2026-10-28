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
