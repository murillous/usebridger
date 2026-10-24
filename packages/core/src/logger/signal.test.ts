import { describe, expect, it, vi } from 'vitest';
import { type LogSignal, Observers } from '#observers/observers.ts';
import { defineLogEvent } from './define-event.ts';
import { createSecretSet } from './secrets.ts';
import { createLogSignalTap } from './signal.ts';
import type { Logger } from './types.ts';

const SENT = defineLogEvent({ name: 'clima.forecast.sent', level: 'info', message: 'enviada' });

describe('createLogSignalTap', () => {
  it('chama o event do logger próprio e ainda emite o sinal log', () => {
    const observers = new Observers(() => undefined);
    const signals: LogSignal[] = [];
    observers.add('clima', 'log', (signal) => signals.push(signal));
    const event = vi.fn();
    const inner: Logger = {
      level: 'info',
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      event,
      child: () => inner,
    };
    const log = createLogSignalTap(observers, createSecretSet()).wrap(inner);

    log.event(SENT, { cidade: 'Recife' });

    expect(event).toHaveBeenCalledExactlyOnceWith(SENT, { cidade: 'Recife' });
    expect(inner.info).not.toHaveBeenCalled();
    expect(signals).toEqual([
      expect.objectContaining({
        level: 'info',
        message: 'enviada',
        fields: { cidade: 'Recife', event: 'clima.forecast.sent' },
      }),
    ]);
  });

  it('não repassa no sinal as chaves que a linha descarta (campos e bindings do child)', () => {
    const observers = new Observers(() => undefined);
    const signals: LogSignal[] = [];
    observers.add('clima', 'log', (signal) => signals.push(signal));
    const inner: Logger = {
      level: 'info',
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      event: vi.fn(),
      child: () => inner,
    };
    const log = createLogSignalTap(observers, createSecretSet()).wrap(inner);

    log
      .child({ event: 'x', level: 'fake', chat: 'c1' })
      .info('oi', { level: 'fake', time: 't', msg: 'm', cidade: 'Recife' });

    expect(signals).toHaveLength(1);
    expect(signals[0]?.fields).toEqual({ chat: 'c1', cidade: 'Recife' });
  });
});
