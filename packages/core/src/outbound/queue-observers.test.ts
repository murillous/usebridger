// ADR 0106 (#148): o sinal `outbound.sent` que a fila de saída emite a cada `send`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Observers, type OutboundSentSignal } from '#observers/observers.ts';
import type { MessageKey, OutgoingContent, SendOptions } from '#transport/types.ts';
import { OutboundQueue, type QueueSendOptions, REPLY_ORIGIN } from './queue.ts';

const text = (t: string): OutgoingContent => ({ type: 'text', text: t });

function setup(failures = 0) {
  const sent: OutgoingContent[] = [];
  const options: (SendOptions | undefined)[] = [];
  let left = failures;
  const signals: OutboundSentSignal[] = [];
  const observers = new Observers(() => undefined);
  const queue = new OutboundQueue({
    transport: {
      name: 'fake',
      capabilities: new Set(['send.text', 'send.image', 'quoted']),
      send: async (chatId: string, content: OutgoingContent, o?: SendOptions) => {
        options.push(o);
        if (left > 0) {
          left--;
          throw new Error('instável');
        }
        sent.push(content);
        return { chatId, id: `m${sent.length}`, fromMe: true, senderId: null } as MessageKey;
      },
      sendTyping: async () => undefined,
    },
    globalIntervalMs: 100,
    chatIntervalMs: 1000,
    retry: { maxAttempts: 3, baseDelayMs: 500 },
    random: () => 1,
    clock: () => Date.now(),
    observers,
  });
  return { queue, observers, signals, options, sent };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('OutboundQueue: outbound.sent (ADR 0106)', () => {
  it('sem observador, não emite', async () => {
    const { queue, observers } = setup();
    const emit = vi.spyOn(observers, 'emit');
    await queue.send('a', text('oi'));
    expect(emit).not.toHaveBeenCalled();
  });

  it('conta as re-tentativas e mede a espera até o último despacho, com a origem da resposta', async () => {
    const { queue, observers, signals, options } = setup(1);
    observers.add('p', 'outbound.sent', (s) => signals.push(s));
    const sendOptions: QueueSendOptions = {
      priority: 'high',
      [REPLY_ORIGIN]: { chatType: 'group', messageId: 'in-1' },
    };
    // A segunda mensagem espera o intervalo do chat (1000 ms) depois da primeira.
    const first = queue.send('a', text('um'));
    const second = queue.send('a', text('dois'), sendOptions);
    await vi.runAllTimersAsync();
    await Promise.all([first, second]);

    expect(signals).toEqual([
      { chatId: 'a', kind: 'text', status: 'sent', queuedMs: 1000, retries: 1 },
      {
        chatId: 'a',
        chatType: 'group',
        kind: 'text',
        status: 'sent',
        queuedMs: 2000,
        retries: 0,
        replyTo: 'in-1',
      },
    ]);
    // A origem é do kernel: o transport não a recebe.
    for (const o of options) expect(Object.getOwnPropertySymbols(o ?? {})).toEqual([]);
  });

  it('`failed` quando o transport esgota as tentativas e `dropped` quando a fila recusa', async () => {
    const { queue, observers, signals } = setup(3);
    observers.add('p', 'outbound.sent', (s) => signals.push(s));
    const failing = queue.send('a', text('um')).catch(() => undefined);
    await vi.runAllTimersAsync();
    await failing;
    await queue.close();
    await queue.send('a', text('dois')).catch(() => undefined);

    expect(signals.map(({ status, retries }) => [status, retries])).toEqual([
      ['failed', 2],
      ['dropped', 0],
    ]);
  });
});

describe('Observers', () => {
  it('emite na ordem de registro e isola a exceção de cada observador', () => {
    const errors: unknown[] = [];
    const observers = new Observers((event) => errors.push(event));
    const calls: string[] = [];
    observers.add('a', 'outbound.sent', () => {
      throw new Error('boom');
    });
    observers.add('b', 'outbound.sent', () => calls.push('b'));
    const signal: OutboundSentSignal = {
      chatId: 'c',
      kind: 'text',
      status: 'sent',
      queuedMs: 0,
      retries: 0,
    };

    observers.emit('outbound.sent', signal);

    expect(calls).toEqual(['b']);
    expect(errors).toMatchObject([{ plugin: 'a', phase: 'observer', event: 'outbound.sent' }]);
  });

  it('observador async que rejeita vira onError e os demais seguem', async () => {
    const errors: unknown[] = [];
    const observers = new Observers((event) => errors.push(event));
    const calls: string[] = [];
    observers.add('a', 'outbound.sent', async () => {
      throw new Error('boom');
    });
    observers.add('b', 'outbound.sent', () => calls.push('b'));
    const signal: OutboundSentSignal = {
      chatId: 'c',
      kind: 'text',
      status: 'sent',
      queuedMs: 0,
      retries: 0,
    };

    observers.emit('outbound.sent', signal);
    await Promise.resolve();

    expect(calls).toEqual(['b']);
    expect(errors).toMatchObject([{ plugin: 'a', phase: 'observer', event: 'outbound.sent' }]);
  });

  it('`removePlugin` tira só as assinaturas do plugin, e `has` reflete a lista', () => {
    const observers = new Observers(() => undefined);
    expect(observers.has('message.handled')).toBe(false);
    observers.add('a', 'message.handled', () => undefined);
    observers.add('b', 'outbound.sent', () => undefined);
    observers.removePlugin('a');
    expect(observers.has('message.handled')).toBe(false);
    expect(observers.has('outbound.sent')).toBe(true);
  });

  it('um observador que sai durante a emissão não muda a rodada em curso', () => {
    const observers = new Observers(() => undefined);
    const calls: string[] = [];
    let offB = (): void => undefined;
    observers.add('a', 'outbound.sent', () => {
      calls.push('a');
      offB();
    });
    offB = observers.add('b', 'outbound.sent', () => calls.push('b'));
    const signal: OutboundSentSignal = {
      chatId: 'c',
      kind: 'text',
      status: 'sent',
      queuedMs: 0,
      retries: 0,
    };
    observers.emit('outbound.sent', signal);
    observers.emit('outbound.sent', signal);
    expect(calls).toEqual(['a', 'b', 'a']);
  });
});
