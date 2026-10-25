import {
  bold,
  ConversationWindowError,
  type OutgoingContent,
  UnsupportedError,
} from '@usebridger/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SELF, FakeTransport } from './fake-transport.ts';
import { buildMessage } from './incoming.ts';

const GROUP = {
  id: 'grupo@fake',
  title: 'Grupo',
  description: null,
  ownerId: 'dona@fake',
  participants: [],
};

describe('FakeTransport', () => {
  it('self só existe depois do connect(); connect e disconnect publicam o status', async () => {
    const transport = new FakeTransport();
    const statuses: string[] = [];
    transport.on('connection.status', (s) => void statuses.push(s.status));

    expect(transport.self).toBeNull();
    await transport.connect();
    expect(transport.self).toEqual(DEFAULT_SELF);
    await transport.disconnect();
    await transport.disconnect();

    expect(statuses).toEqual(['open', 'closed']);
  });

  it('registra envios com a citação, as menções e a chave devolvida', async () => {
    const transport = new FakeTransport();
    const quoted = buildMessage({ text: 'oi' });

    const key = await transport.send(
      'chat@fake',
      { type: 'text', text: 'olá' },
      { quoted, mentions: ['user@fake'] },
    );

    expect(transport.sent).toEqual([
      {
        chatId: 'chat@fake',
        content: { type: 'text', text: 'olá' },
        quoted,
        mentions: ['user@fake'],
        key,
      },
    ]);
  });

  it('expõe os `limits` e registra a árvore da edição formatada (ADR 0057)', async () => {
    expect(new FakeTransport().limits).toBeUndefined();
    const transport = new FakeTransport({ limits: { text: 10 } });
    expect(transport.limits).toEqual({ text: 10 });
    const key = await transport.send('chat@fake', { type: 'text', text: 'a' });
    await transport.edit(key, 'b', bold('b'));
    expect(transport.edits).toEqual([{ key, text: 'b', formatted: bold('b') }]);
  });

  it('registra reações, edições, deleções, "digitando" e participantes', async () => {
    const transport = new FakeTransport();
    const key = await transport.send('chat@fake', { type: 'text', text: 'a' });

    await transport.react(key, '👍');
    await transport.edit(key, 'b');
    await transport.delete(key);
    await transport.sendTyping('chat@fake', 'text');
    await transport.updateGroupParticipants('grupo@fake', ['x@fake'], 'remove');

    expect(transport.reactions).toEqual([{ key, emoji: '👍' }]);
    expect(transport.edits).toEqual([{ key, text: 'b' }]);
    expect(transport.deletions).toEqual([key]);
    expect(transport.typing).toEqual([{ chatId: 'chat@fake', kind: 'text' }]);
    expect(transport.participantUpdates).toEqual([
      { groupId: 'grupo@fake', participantIds: ['x@fake'], action: 'remove' },
    ]);

    transport.clear();
    expect(transport.sent).toEqual([]);
    expect(transport.reactions).toEqual([]);
  });

  it('lança UnsupportedError fora das capabilities declaradas', async () => {
    const transport = new FakeTransport({ capabilities: ['send.text'] });
    const key = { chatId: 'chat@fake', id: 'm1', fromMe: false, senderId: null };

    await expect(
      transport.send('chat@fake', { type: 'sticker', media: Buffer.from('x') }),
    ).rejects.toBeInstanceOf(UnsupportedError);
    await expect(transport.react(key, '👍')).rejects.toBeInstanceOf(UnsupportedError);
    expect(transport.sent).toEqual([]);
  });

  it('getGroupMetadata devolve os grupos registrados e falha nos desconhecidos', async () => {
    const transport = new FakeTransport({ groups: [GROUP] });

    await expect(transport.getGroupMetadata('grupo@fake')).resolves.toEqual(GROUP);
    await expect(transport.getGroupMetadata('outro@fake')).rejects.toThrow(/setGroup/);

    transport.setGroup({ ...GROUP, id: 'outro@fake' });
    await expect(transport.getGroupMetadata('outro@fake')).resolves.toMatchObject({
      id: 'outro@fake',
    });
  });
});

describe('FakeTransport: janela de atendimento', () => {
  const TTL = 1000;
  const text: OutgoingContent = { type: 'text', text: 'oi' };
  const template: OutgoingContent = { type: 'template', name: 'retomar', language: 'pt_BR' };
  const inbound = (fromMe = false) => buildMessage({ text: 'oi', chat: 'c@fake', fromMe });
  const make = () => new FakeTransport({ window: { enabled: true, ttlMs: TTL } });

  afterEach(() => void vi.useRealTimers());

  it('sem inbound: envio livre rejeita com closedAt null e nada entra em sent', async () => {
    const transport = make();
    const error = await transport.send('c@fake', text).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConversationWindowError);
    expect((error as ConversationWindowError).closedAt).toBeNull();
    expect(transport.sent).toEqual([]);
  });

  it('inbound abre a janela; passado o ttl, fecha com o closedAt certo', async () => {
    vi.useFakeTimers({ now: 10_000 });
    const transport = make();
    transport.emit('message', inbound());
    await transport.send('c@fake', text);
    expect(await transport.window('c@fake')).toEqual({ open: true, expiresAt: new Date(11_000) });

    vi.setSystemTime(11_000);
    const error = await transport.send('c@fake', text).catch((e: unknown) => e);
    expect((error as ConversationWindowError).closedAt).toEqual(new Date(11_000));
    expect(await transport.window('c@fake')).toEqual({ open: false, expiresAt: null });
    expect(transport.sent).toHaveLength(1);
  });

  it('mensagem fromMe não abre a janela; outro chat também não', async () => {
    const transport = make();
    transport.emit('message', inbound(true));
    expect(await transport.window('c@fake')).toEqual({ open: false, expiresAt: null });
    transport.emit('message', inbound());
    expect((await transport.window('outro@fake'))?.open).toBe(false);
  });

  it('template passa com a janela fechada e entra em sent', async () => {
    const transport = make();
    await transport.send('c@fake', template);
    expect(transport.sent.map((s) => s.content)).toEqual([template]);
  });

  it('sem a opção (ou enabled: false): envio livre passa e window dá null', async () => {
    for (const transport of [
      new FakeTransport(),
      new FakeTransport({ window: { enabled: false, ttlMs: TTL } }),
    ]) {
      await transport.send('c@fake', text);
      expect(await transport.window('c@fake')).toBeNull();
    }
  });

  it('capability faltando continua UnsupportedError, antes da janela', async () => {
    const transport = new FakeTransport({
      capabilities: ['send.text'],
      window: { enabled: true, ttlMs: TTL },
    });
    await expect(transport.send('c@fake', template)).rejects.toBeInstanceOf(UnsupportedError);
  });
});
