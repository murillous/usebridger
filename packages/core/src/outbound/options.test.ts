import { describe, expect, it } from 'vitest';
import type { Capability } from '#transport/capabilities.ts';
import type { TransportPacing } from '#transport/types.ts';
import { resolveOutboundOptions } from './options.ts';
import type { OutboundQueueOptions, OutboundTransport } from './queue.ts';
import { isTransient } from './retry.ts';

function transport(
  capabilities: Capability[] = ['send.text', 'typing'],
  pacing?: TransportPacing,
): OutboundTransport {
  return {
    name: 'fake',
    capabilities: new Set(capabilities),
    send: async () => ({ chatId: 'a', id: 'm1', fromMe: true, senderId: null }),
    sendTyping: async () => undefined,
    ...(pacing && { pacing }),
  };
}

const resolve = (options: Partial<OutboundQueueOptions> = {}) =>
  resolveOutboundOptions({ transport: transport(), ...options });

describe('resolveOutboundOptions', () => {
  it('aplica os padrões e congela o resultado', () => {
    const config = resolve();
    expect(config).toMatchObject({
      globalIntervalMs: 300,
      chatIntervalMs: 1000,
      maxPending: 1000,
      retry: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 30_000, isRetryable: isTransient },
      humanize: null,
      onTypingError: undefined,
      maxPauseMs: 60_000,
      sendTimeoutMs: 30_000,
      random: Math.random,
    });
    expect(typeof config.clock()).toBe('number');
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.retry)).toBe(true);
  });

  it('o ritmo do transport vale sem config, e a config do bot vale sobre ele', () => {
    const paced = transport(undefined, { globalIntervalMs: 50, chatIntervalMs: 200 });
    expect(resolveOutboundOptions({ transport: paced })).toMatchObject({
      globalIntervalMs: 50,
      chatIntervalMs: 200,
    });
    expect(resolveOutboundOptions({ transport: paced, chatIntervalMs: 10 })).toMatchObject({
      globalIntervalMs: 50,
      chatIntervalMs: 10,
    });
  });

  it('humanize: true usa os padrões; sem a capability typing, fica desligada', () => {
    expect(resolve({ humanize: true }).humanize).toEqual({
      msPerChar: 50,
      minMs: 500,
      maxMs: 3000,
    });
    expect(resolve({ humanize: { maxMs: 100 } }).humanize).toEqual({
      msPerChar: 50,
      minMs: 500,
      maxMs: 100,
    });
    const mute = resolveOutboundOptions({ transport: transport(['send.text']), humanize: true });
    expect(mute.humanize).toBeNull();
  });

  it('aceita Infinity onde ele desliga o limite', () => {
    const inf = Number.POSITIVE_INFINITY;
    expect(resolve({ maxPending: inf, maxPauseMs: inf, sendTimeoutMs: inf })).toMatchObject({
      maxPending: inf,
      maxPauseMs: inf,
      sendTimeoutMs: inf,
    });
  });

  it('recusa valores inválidos com RangeError e a mensagem de cada opção', () => {
    const cases: [Partial<OutboundQueueOptions>, string][] = [
      [{ globalIntervalMs: -1 }, 'globalIntervalMs deve ser um número finito >= 0 (recebido: -1)'],
      [{ chatIntervalMs: Number.NaN }, 'chatIntervalMs deve ser um número finito >= 0'],
      [{ maxPending: 1.5 }, 'maxPending deve ser inteiro >= 0 ou Infinity (recebido: 1.5)'],
      [{ retry: { maxAttempts: 0 } }, 'retry.maxAttempts deve ser inteiro >= 1 (recebido: 0)'],
      [{ retry: { baseDelayMs: -1 } }, 'retry.baseDelayMs deve ser um número finito >= 0'],
      [{ retry: { maxDelayMs: Number.POSITIVE_INFINITY } }, 'retry.maxDelayMs deve ser'],
      [{ humanize: { msPerChar: -1 } }, 'humanize.msPerChar deve ser'],
      [{ maxPauseMs: -1 }, 'maxPauseMs deve ser >= 0 ou Infinity (recebido: -1)'],
      [{ sendTimeoutMs: 0 }, 'sendTimeoutMs deve ser > 0 ou Infinity (recebido: 0)'],
    ];
    for (const [options, message] of cases) {
      expect(() => resolve(options)).toThrow(RangeError);
      expect(() => resolve(options)).toThrow(message);
    }
  });

  it('recusa pacing inválido do transport apontando a origem', () => {
    const bad = transport(undefined, { globalIntervalMs: -5 });
    expect(() => resolveOutboundOptions({ transport: bad })).toThrow(
      'transport.pacing.globalIntervalMs deve ser um número finito >= 0',
    );
  });
});
