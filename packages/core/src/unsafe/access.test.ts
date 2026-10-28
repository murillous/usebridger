import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '#logger/types.ts';
import type { Message } from '#message/types.ts';
import type { Interaction } from '#transport/types.ts';
import { createUnsafeAccess } from './access.ts';

function fakeLogger() {
  const log = {
    level: 'trace' as const,
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    event: vi.fn(),
    child: (): Logger => log,
  };
  return log;
}

describe('createUnsafeAccess', () => {
  it('native devolve o objeto nativo atual do transport, mesmo depois de trocado', () => {
    const transport: { name: string; native: unknown } = { name: 'baileys', native: { socket: 1 } };
    const unsafe = createUnsafeAccess({ transport, log: fakeLogger() }).forPlugin({
      name: 'p',
      transports: ['baileys'],
    });

    expect(unsafe.native).toEqual({ socket: 1 });
    transport.native = { socket: 2 };
    expect(unsafe.native).toEqual({ socket: 2 });
  });

  it('só avisa quando native é lido', () => {
    const log = fakeLogger();
    createUnsafeAccess({ transport: { name: 'baileys', native: {} }, log }).forPlugin({
      name: 'p',
    });
    expect(log.event).not.toHaveBeenCalled();
  });

  it('avisa uma única vez por plugin, mesmo com vários Unsafe do mesmo plugin', () => {
    const log = fakeLogger();
    const access = createUnsafeAccess({ transport: { name: 'baileys', native: {} }, log });
    const first = access.forPlugin({ name: 'a', transports: ['baileys'] });
    const second = access.forPlugin({ name: 'a', transports: ['baileys'] });

    void first.native;
    void first.native;
    void second.native;
    expect(log.event).toHaveBeenCalledTimes(1);

    void access.forPlugin({ name: 'b', transports: ['baileys'] }).native;
    expect(log.event).toHaveBeenCalledTimes(2);
  });

  it('o registro de avisos é por bot: outra instância avisa de novo', () => {
    const log = fakeLogger();
    const transport = { name: 'baileys', native: {} };
    void createUnsafeAccess({ transport, log }).forPlugin({ name: 'a' }).native;
    void createUnsafeAccess({ transport, log }).forPlugin({ name: 'a' }).native;
    expect(log.event).toHaveBeenCalledTimes(2);
  });

  it('o aviso é warn e traz plugin, transport e o acesso nos campos', () => {
    const log = fakeLogger();
    const access = createUnsafeAccess({ transport: { name: 'baileys', native: {} }, log });
    void access.forPlugin({ name: 'stickers', transports: ['baileys'] }).native;

    expect(log.event).toHaveBeenCalledTimes(1);
    const [event, fields] = log.event.mock.calls[0] ?? [];
    expect(event).toMatchObject({ name: 'transport.unsafe.accessed', level: 'warn' });
    expect(fields).toEqual({
      plugin: 'stickers',
      transport: 'baileys',
      access: 'ctx.unsafe.native',
    });
  });

  it('sem transports no manifesto, o aviso diz que o plugin fica preso ao transport', () => {
    const log = fakeLogger();
    const access = createUnsafeAccess({ transport: { name: 'baileys', native: {} }, log });
    const unsafe = access.forPlugin({ name: 'stickers' });

    // O acesso não é bloqueado.
    expect(unsafe.native).toEqual({});
    const [event, fields] = log.event.mock.calls[0] ?? [];
    expect(event).toMatchObject({ name: 'transport.unsafe.undeclared', level: 'warn' });
    expect(event?.message).toContain('declare transports');
    expect(fields).toMatchObject({ plugin: 'stickers', transport: 'baileys' });
  });
});

describe('createUnsafeAccess: raw (ADR 0062)', () => {
  const message = { id: 'm1' } as unknown as Message;
  const interaction = { id: 'i1' } as unknown as Interaction;

  it('devolve o que o transport.raw devolve para a mensagem', () => {
    const raw = vi.fn((source: Message | Interaction) => (source === message ? { proto: 1 } : 0));
    const unsafe = createUnsafeAccess({
      transport: { name: 'baileys', native: {}, raw },
      log: fakeLogger(),
    }).forPlugin({ name: 'p', transports: ['baileys'] });

    expect(unsafe.raw(message)).toEqual({ proto: 1 });
    expect(raw).toHaveBeenCalledWith(message);
  });

  it('transport sem raw devolve undefined, e o acesso ainda avisa', () => {
    const log = fakeLogger();
    const unsafe = createUnsafeAccess({ transport: { name: 'web', native: {} }, log }).forPlugin({
      name: 'p',
      transports: ['web'],
    });

    expect(unsafe.raw(message)).toBeUndefined();
    expect(log.event).toHaveBeenCalledTimes(1);
  });

  it('mensagem montada de uma interação pergunta ao transport pela interação', () => {
    const raw = vi.fn((source: Message | Interaction) =>
      source === interaction ? { token: 't' } : undefined,
    );
    const access = createUnsafeAccess({
      transport: { name: 'discord', native: {}, raw },
      log: fakeLogger(),
      interactionOf: (m) => (m === message ? interaction : undefined),
    });
    const unsafe = access.forPlugin({ name: 'p', transports: ['discord'] });

    expect(unsafe.raw(message)).toEqual({ token: 't' });
    const other = { id: 'm2' } as unknown as Message;
    unsafe.raw(other);
    expect(raw).toHaveBeenLastCalledWith(other);
  });

  it('raw avisa uma vez por plugin, à parte do native, citando ctx.unsafe.raw()', () => {
    const log = fakeLogger();
    const access = createUnsafeAccess({ transport: { name: 'baileys', native: {} }, log });
    const first = access.forPlugin({ name: 'a', transports: ['baileys'] });
    const second = access.forPlugin({ name: 'a', transports: ['baileys'] });

    first.raw(message);
    second.raw(message);
    expect(log.event).toHaveBeenCalledTimes(1);
    const [, fields] = log.event.mock.calls[0] ?? [];
    expect(fields).toEqual({ plugin: 'a', transport: 'baileys', access: 'ctx.unsafe.raw()' });

    void first.native;
    expect(log.event).toHaveBeenCalledTimes(2);
    expect(log.event.mock.calls[1]?.[1]).toMatchObject({ access: 'ctx.unsafe.native' });
  });

  it('sem transports no manifesto, o aviso de raw diz que o plugin fica preso ao transport', () => {
    const log = fakeLogger();
    createUnsafeAccess({ transport: { name: 'telegram', native: {} }, log })
      .forPlugin({ name: 'p' })
      .raw(message);

    const [event, fields] = log.event.mock.calls[0] ?? [];
    expect(event).toMatchObject({ name: 'transport.unsafe.undeclared' });
    expect(fields).toMatchObject({ transport: 'telegram', access: 'ctx.unsafe.raw()' });
  });
});
