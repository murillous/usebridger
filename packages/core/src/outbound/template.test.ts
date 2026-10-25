// ADR 0124: template na fila de saída (não divide, não re-tenta recusa de janela) e `send.window`.

import { describe, expect, it, vi } from 'vitest';
import { createMemoryStorage } from '#storage/memory.ts';
import { assertCanSend, type Capability, UnsupportedError } from '#transport/capabilities.ts';
import { defineTransport } from '#transport/define.ts';
import type { MessageKey, OutgoingContent, Transport } from '#transport/types.ts';
import { ConversationWindowError } from '#transport/window.ts';
import { createOutbound } from './actions.ts';
import { OutboundQueue } from './queue.ts';

const template: OutgoingContent = {
  type: 'template',
  name: 'retomar_atendimento',
  language: 'pt_BR',
  params: { body: ['x'.repeat(200), 'y'.repeat(200)] },
};

function setup(overrides: Partial<Transport> = {}, capabilities: Capability[] = ['send.template']) {
  const send = vi.fn(
    async (chatId: string, _content: OutgoingContent): Promise<MessageKey> => ({
      chatId,
      id: 'm1',
      fromMe: true,
      senderId: null,
    }),
  );
  const transport = {
    name: 'fake',
    capabilities: new Set(capabilities),
    limits: { text: 10, caption: 10 },
    send,
    sendTyping: vi.fn(async () => undefined),
    react: vi.fn(async () => undefined),
    edit: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    ...overrides,
  } satisfies Partial<Transport>;
  const queue = new OutboundQueue({
    transport,
    globalIntervalMs: 0,
    chatIntervalMs: 0,
    retry: { baseDelayMs: 1 },
  });
  return { send, outbound: createOutbound(queue, transport) };
}

describe('send.template', () => {
  it('assertCanSend exige a capability', () => {
    const holder = { name: 'fake', capabilities: new Set<Capability>() };
    expect(() => assertCanSend(holder, template)).toThrow(UnsupportedError);
    expect(() =>
      assertCanSend({ ...holder, capabilities: new Set<Capability>(['send.template']) }, template),
    ).not.toThrow();
  });

  it('a fila não divide o template, mesmo acima de limits.text', async () => {
    const { send, outbound } = setup();
    await outbound.send('c', template);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[1]).toEqual(template);
  });
});

describe('ConversationWindowError', () => {
  it('a fila não re-tenta: uma tentativa, rejeita com a instância', async () => {
    const error = new ConversationWindowError('c', new Date(0));
    const failing = vi.fn(async (): Promise<MessageKey> => {
      throw error;
    });
    const { outbound } = setup({ send: failing }, ['send.text']);
    await expect(outbound.send('c', { type: 'text', text: 'oi' })).rejects.toBe(error);
    expect(failing).toHaveBeenCalledTimes(1);
    expect(error.retryable).toBe(false);
    expect(new ConversationWindowError('c', null).closedAt).toBeNull();
  });
});

describe('ctx.send.window', () => {
  it('transport sem o método resolve null', async () => {
    await expect(setup().outbound.window('c')).resolves.toBeNull();
  });

  it('com o método, repassa o valor', async () => {
    const value = { open: false, expiresAt: new Date(0) };
    const window = vi.fn(async () => value);
    await expect(setup({ window }).outbound.window('c')).resolves.toBe(value);
    expect(window).toHaveBeenCalledWith('c');
  });

  it('defineTransport repassa window', async () => {
    const value = { open: true, expiresAt: null };
    const factory = defineTransport(() => ({
      name: 'w',
      capabilities: ['send.text'],
      async connect() {
        // Sem conexão real.
      },
      async disconnect() {
        // Sem conexão real.
      },
      async send(chatId): Promise<MessageKey> {
        return { chatId, id: 'm', fromMe: true, senderId: null };
      },
      async window() {
        return value;
      },
    }));
    const transport = factory({
      session: 'default',
      auth: createMemoryStorage().authState('default'),
      log: { event: vi.fn() } as never,
    });
    await expect(transport.window?.('c')).resolves.toBe(value);
  });
});
