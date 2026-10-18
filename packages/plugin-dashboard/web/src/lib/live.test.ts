import { describe, expect, it } from 'vitest';
import {
  backoffDelay,
  createLiveClient,
  initialLive,
  MAX_LOGS,
  reduceLive,
  type SocketLike,
} from './live.ts';
import type { LogEntry, StatusView } from './types.ts';

const status: StatusView = {
  transport: 't',
  session: 'default',
  status: 'connecting',
  updatedAt: 1,
};
const entry = (n: number): LogEntry => ({ level: 'info', time: n, message: `m${n}` });

describe('reduceLive', () => {
  it('snapshot, status, qr, código e log', () => {
    let s = reduceLive(initialLive, { type: 'snapshot', status, logs: [entry(1)] }, 10);
    expect(s.status?.status).toBe('connecting');
    expect(s.lastUpdate).toBe(10);
    s = reduceLive(s, { type: 'qr', qr: 'QR' }, 11);
    s = reduceLive(s, { type: 'pairing-code', code: 'ABCD' }, 12);
    expect(s.status).toMatchObject({ qr: 'QR', pairingCode: 'ABCD' });
    s = reduceLive(s, { type: 'status', ...status, status: 'open' }, 13);
    expect(s.status).toEqual({ ...status, status: 'open' });
    s = reduceLive(s, { type: 'log', entry: entry(2) }, 14);
    expect(s.logs.map((l) => l.message)).toEqual(['m1', 'm2']);
  });

  it('limita o buffer de logs', () => {
    let s = initialLive;
    for (let i = 0; i < MAX_LOGS + 5; i++) s = reduceLive(s, { type: 'log', entry: entry(i) }, i);
    expect(s.logs).toHaveLength(MAX_LOGS);
    expect(s.logs.at(-1)?.message).toBe(`m${MAX_LOGS + 4}`);
  });
});

describe('backoffDelay', () => {
  it('dobra até 15 s', () => {
    expect([0, 1, 2, 3, 4, 5].map(backoffDelay)).toEqual([1000, 2000, 4000, 8000, 15000, 15000]);
  });
});

describe('createLiveClient', () => {
  function setup() {
    const sockets: SocketLike[] = [];
    const delays: number[] = [];
    const timers: (() => void)[] = [];
    const states: boolean[] = [];
    const messages: unknown[] = [];
    const client = createLiveClient({
      open() {
        const socket: SocketLike = {
          onopen: null,
          onmessage: null,
          onclose: null,
          close: () => undefined,
        };
        sockets.push(socket);
        return socket;
      },
      onMessage: (m) => messages.push(m),
      onConnection: (c) => states.push(c),
      schedule(run, ms) {
        delays.push(ms);
        timers.push(run);
        return () => timers.splice(timers.indexOf(run), 1);
      },
    });
    return { sockets, delays, timers, states, messages, client };
  }

  it('reconecta com backoff e zera ao abrir', () => {
    const t = setup();
    t.sockets[0]?.onclose?.();
    t.sockets[0]?.onclose?.();
    expect(t.delays).toEqual([1000, 2000]);
    t.timers[0]?.();
    expect(t.sockets).toHaveLength(2);
    t.sockets[1]?.onopen?.();
    t.sockets[1]?.onclose?.();
    expect(t.delays.at(-1)).toBe(1000);
    expect(t.states).toEqual([false, false, true, false]);
  });

  it('entrega mensagens JSON e ignora lixo', () => {
    const t = setup();
    t.sockets[0]?.onmessage?.({ data: '{"type":"qr","qr":"x"}' });
    t.sockets[0]?.onmessage?.({ data: 'não é json' });
    expect(t.messages).toEqual([{ type: 'qr', qr: 'x' }]);
  });

  it('close() cancela a reconexão', () => {
    const t = setup();
    t.sockets[0]?.onclose?.();
    t.client.close();
    expect(t.timers).toHaveLength(0);
    t.sockets[0]?.onclose?.();
    expect(t.delays).toHaveLength(1);
  });
});
