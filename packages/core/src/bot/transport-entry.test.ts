import { describe, expect, it, vi } from 'vitest';
import type { EventBus } from '#events/bus.ts';
import type { Chat, Contact, Message } from '#message/types.ts';
import type { OutboundQueue } from '#outbound/queue.ts';
import { InboundQueue } from '#queue/inbound.ts';
import { TenantScope } from '#tenant/scope.ts';
import type { Transport } from '#transport/types.ts';
import { deferred, message, recordingLogger } from './harness.test-support.ts';
import type { InboundFlow } from './inbound-flow.ts';
import { ReadyGate } from './ready-gate.ts';
import { createTransportEntry, type TransportEntryDeps } from './transport-entry.ts';

type Handler = (payload: unknown) => void;

/** Transport falso: só guarda os handlers de `on` e deixa o teste dispará-los. */
function fakeTransport(): {
  readonly transport: Transport;
  readonly emit: (event: string, payload: unknown) => void;
  readonly count: () => number;
} {
  const handlers = new Map<string, Set<Handler>>();
  const transport = {
    on(event: string, handler: Handler) {
      const set = handlers.get(event) ?? new Set<Handler>();
      set.add(handler);
      handlers.set(event, set);
      return () => set.delete(handler);
    },
  } as unknown as Transport;
  return {
    transport,
    emit: (event, payload) => {
      for (const handler of handlers.get(event) ?? []) handler(payload);
    },
    count: () => [...handlers.values()].reduce((sum, set) => sum + set.size, 0),
  };
}

const CHAT: Chat = { id: 'chat@test', isGroup: false };
const SENDER: Contact = { id: 'user@test', name: 'Usuária', phone: null };

function setup(overrides: Partial<TransportEntryDeps> = {}) {
  const fake = fakeTransport();
  const lines: Parameters<typeof recordingLogger>[0] = [];
  const log = recordingLogger(lines);
  const bus = { emit: vi.fn() };
  const flow = {
    handleMessage: vi.fn<() => Promise<void>>(async () => undefined),
    handleEdited: vi.fn(async () => undefined),
    handleInteraction: vi.fn(async () => undefined),
    expireReply: vi.fn(async () => undefined),
  };
  const outbound = { pause: vi.fn(), resume: vi.fn() };
  const conversations = { expire: vi.fn() };
  const gate = new ReadyGate();
  const deps: TransportEntryDeps = {
    transport: fake.transport,
    inbound: new InboundQueue({ onError: () => undefined, ...{ maxPendingPerChat: 100 } }),
    outbound: outbound as unknown as OutboundQueue,
    tenants: new TenantScope(),
    flow: flow as unknown as InboundFlow,
    bus: bus as unknown as EventBus,
    conversations,
    reconnector: undefined,
    gate,
    chatIsAllowed: () => true,
    dropsSelf: false,
    dropsBots: false,
    stopping: () => false,
    log: () => log,
    ...overrides,
  };
  const entry = createTransportEntry(deps);
  return { ...fake, entry, bus, flow, outbound, conversations, gate, log, lines };
}

const reaction = (fromMe: boolean) => ({ chat: CHAT, fromMe, sender: SENDER });
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('createTransportEntry', () => {
  it('enfileira a mensagem no fluxo e loga warn quando a fila do chat descarta', async () => {
    const hold = deferred();
    const t = setup({
      inbound: new InboundQueue({ onError: () => undefined, maxPendingPerChat: 0 }),
    });
    t.flow.handleMessage.mockImplementation(async () => hold.promise);
    t.entry.subscribe();

    const first = message('um');
    const second = message('dois');
    t.emit('message', first);
    t.emit('message', second);

    expect(t.flow.handleMessage).toHaveBeenCalledTimes(1);
    const warn = t.lines.find((line) => line.level === 'warn');
    expect(warn?.message).toBe('mensagem descartada pela fila de entrada');
    expect(warn?.fields).toMatchObject({
      chatId: 'chat@test',
      messageId: (second as Message).id,
      reason: 'full',
    });
    hold.resolve();
  });

  it('evento direto antes do gate espera e é descartado com settle(false)', async () => {
    const t = setup();
    t.entry.subscribe();

    t.emit('reaction', reaction(false));
    await flush();
    expect(t.bus.emit).not.toHaveBeenCalled();

    t.gate.settle(false);
    await flush();
    expect(t.bus.emit).not.toHaveBeenCalled();
  });

  it('evento direto antes do gate vai ao barramento com settle(true)', async () => {
    const t = setup();
    t.entry.subscribe();
    const payload = reaction(false);

    t.emit('reaction', payload);
    t.gate.settle(true);
    await flush();

    expect(t.bus.emit).toHaveBeenCalledWith('reaction', payload);
  });

  it('com o gate aberto, o evento direto vai ao barramento na hora', () => {
    const t = setup();
    t.gate.settle(true);
    t.entry.subscribe();
    const payload = reaction(false);

    t.emit('reaction', payload);

    expect(t.bus.emit).toHaveBeenCalledWith('reaction', payload);
  });

  it('ignoreSelf descarta o evento da própria conta', () => {
    const t = setup({ dropsSelf: true });
    t.gate.settle(true);
    t.entry.subscribe();

    t.emit('reaction', reaction(true));
    expect(t.bus.emit).not.toHaveBeenCalled();

    t.emit('reaction', reaction(false));
    expect(t.bus.emit).toHaveBeenCalledTimes(1);
  });

  it('chat barrado pelo filtro não chega ao barramento', () => {
    const t = setup({ chatIsAllowed: () => false });
    t.gate.settle(true);
    t.entry.subscribe();

    t.emit('reaction', reaction(false));

    expect(t.bus.emit).not.toHaveBeenCalled();
  });

  it('connection.status pausa e retoma a fila de saída e repassa ao barramento', () => {
    const t = setup();
    t.entry.subscribe();

    t.emit('connection.status', { status: 'closed' });
    t.emit('connection.status', { status: 'open' });

    expect(t.outbound.pause).toHaveBeenCalledTimes(1);
    expect(t.outbound.resume).toHaveBeenCalledTimes(1);
    expect(t.bus.emit).toHaveBeenCalledTimes(2);
  });

  it('o QR vai ao barramento e o valor fica só em debug', () => {
    const t = setup();
    t.entry.subscribe();

    t.emit('connection.qr', { qr: 'segredo' });

    expect(t.bus.emit).toHaveBeenCalledWith('connection.qr', { qr: 'segredo' });
    const info = t.lines.filter((line) => line.level === 'info');
    expect(JSON.stringify(info)).not.toContain('segredo');
    expect(t.lines.some((line) => line.level === 'debug' && line.fields['qr'] === 'segredo')).toBe(
      true,
    );
  });

  it('a função devolvida desfaz todas as assinaturas', () => {
    const t = setup();
    const off = t.entry.subscribe();
    expect(t.count()).toBeGreaterThan(0);

    off();

    expect(t.count()).toBe(0);
  });

  describe('expireWait', () => {
    it('com stopping() true expira a espera e não enfileira', async () => {
      const t = setup({ stopping: () => true });

      t.entry.expireWait(CHAT, SENDER);
      await flush();

      expect(t.conversations.expire).toHaveBeenCalledWith(CHAT.id, SENDER.id);
      expect(t.flow.expireReply).not.toHaveBeenCalled();
    });

    it('enfileira a expiração no chat quando há vaga', async () => {
      const t = setup();

      t.entry.expireWait(CHAT, SENDER);
      await flush();

      expect(t.flow.expireReply).toHaveBeenCalledWith(CHAT, SENDER);
      expect(t.conversations.expire).not.toHaveBeenCalled();
    });

    it('fila cheia: expira em silêncio e loga warn', () => {
      const hold = deferred();
      const inbound = new InboundQueue({ onError: () => undefined, maxPendingPerChat: 0 });
      inbound.enqueue(CHAT.id, () => hold.promise);
      const t = setup({ inbound });

      t.entry.expireWait(CHAT, SENDER);

      expect(t.flow.expireReply).not.toHaveBeenCalled();
      expect(t.conversations.expire).toHaveBeenCalledWith(CHAT.id, SENDER.id);
      const warn = t.lines.find((line) => line.level === 'warn');
      expect(warn?.message).toBe(
        'expiração de espera descartada pela fila de entrada; onExpire não roda',
      );
      expect(warn?.fields).toMatchObject({ chatId: CHAT.id, reason: 'full' });
      hold.resolve();
    });
  });
});
