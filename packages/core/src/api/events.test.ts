// M7-5 (ADR 0129): buffer e retomada do stream de eventos.

import { describe, expect, it } from 'vitest';
import { EventStream, type StreamEvent } from './events.ts';

describe('EventStream', () => {
  it('id de outro processo cai no estado atual da conexão', () => {
    const stream = new EventStream();
    stream.publish('connection.status', { status: 'connecting' });
    stream.publish('plugin.status', { name: 'p', status: 'loaded' });
    stream.publish('connection.qr', { qr: 'QR-1' });
    expect(stream.replay('deadbeef-1').map((e) => e.type)).toEqual([
      'connection.status',
      'connection.qr',
    ]);
    expect(stream.replay('lixo')).toEqual(stream.replay(null));
  });

  it('retoma depois do id e guarda só os últimos 1000', () => {
    const stream = new EventStream();
    const seen: StreamEvent[] = [];
    stream.subscribe((event) => event && seen.push(event));
    for (let i = 0; i < 2500; i++) {
      stream.publish('plugin.status', { name: `p${i}`, status: 'loaded' });
    }
    expect(stream.replay(seen[2497]?.id ?? null).map((e) => e.seq)).toEqual([2499, 2500]);
    const old = stream.replay(seen[0]?.id ?? null);
    expect(old).toHaveLength(1000);
    expect(old[0]?.seq).toBe(1501);
  });
});
