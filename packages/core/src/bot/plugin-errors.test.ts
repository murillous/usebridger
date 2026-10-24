import { describe, expect, it, vi } from 'vitest';
import type { PluginErrorEvent } from '#events/types.ts';
import { PluginLifecycleError } from '#plugin/report.ts';
import { recordingLogger } from './harness.test-support.ts';
import { createPluginErrorReporter, logPluginError } from './plugin-errors.ts';

const event: PluginErrorEvent = {
  plugin: 'ping',
  phase: 'command',
  event: 'message.received',
  error: new Error('boom'),
  timedOut: false,
};

describe('logPluginError', () => {
  it('loga em error com a mensagem e os campos do evento', () => {
    const log = recordingLogger();
    logPluginError(log, event);
    expect(log.lines).toEqual([
      {
        level: 'error',
        message: 'plugin falhou',
        fields: {
          plugin: 'ping',
          phase: 'command',
          eventName: 'message.received',
          timedOut: false,
          err: event.error,
          event: 'plugin.failed',
        },
      },
    ]);
  });
});

describe('createPluginErrorReporter', () => {
  it('report loga e emite plugin.error', () => {
    const log = recordingLogger();
    const bus = { emit: vi.fn() };
    createPluginErrorReporter({ log: () => log, bus }).report(event);
    expect(log.lines).toHaveLength(1);
    expect(bus.emit).toHaveBeenCalledWith('plugin.error', event);
  });

  it.each([
    ['context', 'setup'],
    ['setup', 'setup'],
    ['teardown', 'teardown'],
    ['dispose', 'teardown'],
  ] as const)('lifecycle mapeia a fase %s para %s', (from, to) => {
    const log = recordingLogger();
    const bus = { emit: vi.fn() };
    const error = new PluginLifecycleError('ping', from, 'falhou', true);
    createPluginErrorReporter({ log: () => log, bus }).lifecycle(error);
    expect(bus.emit).toHaveBeenCalledWith('plugin.error', {
      plugin: 'ping',
      phase: to,
      event: null,
      error,
      timedOut: true,
    });
    expect(log.lines).toEqual([]);
  });

  it('lifecycle usa a cause quando existe', () => {
    const bus = { emit: vi.fn() };
    const cause = new Error('origem');
    const error = new PluginLifecycleError('ping', 'setup', 'falhou', false, cause);
    createPluginErrorReporter({ log: () => recordingLogger(), bus }).lifecycle(error);
    expect(bus.emit).toHaveBeenCalledWith(
      'plugin.error',
      expect.objectContaining({ error: cause, timedOut: false }),
    );
  });
});
