// Persistência dos nomes de contatos no auth state (#111, ADR 0097): escrita em lote com
// debounce, leitura lazy com cache negativo e descarte no logout.

import { createMemoryStorage, type Logger } from '@usebridger/core';
import type { AuthStateStore } from '@usebridger/core/adapter';
import { DisconnectReason } from 'baileys';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContactBook, learnContacts, toReaction } from './events.ts';
import { boom, FakeDriver } from './fake-socket.test-support.ts';
import type { NormalizeEnv } from './normalize.ts';
import { BaileysTransport } from './transport.ts';

const ALICE = '5511911110000@s.whatsapp.net';
const BOB_LID = '222222222222222@lid';
const BOB = '5521922220000@s.whatsapp.net';
const NAME_KEY = 'bridger-contact-name';

const env: Pick<NormalizeEnv, 'pnForLid'> = { pnForLid: async () => null };
const fullEnv: NormalizeEnv = {
  selfIds: ['5511999990000@s.whatsapp.net'],
  pnForLid: async (lid) => (lid === BOB_LID ? BOB : null),
  download: async () => Buffer.from(''),
  stream: async () => new ReadableStream(),
};

/** Auth state em memória que conta as chamadas e pode falhar sob demanda. */
function spyStore() {
  const inner = createMemoryStorage().authState('default');
  const calls = { get: [] as string[][], set: [] as Record<string, unknown>[] };
  const fail = { get: false, set: false };
  const store: AuthStateStore = {
    ...inner,
    getKeys: async (type, ids) => {
      calls.get.push([...ids]);
      if (fail.get) throw new Error('leitura quebrou');
      return inner.getKeys(type, ids);
    },
    setKeys: async (data) => {
      calls.set.push(data[NAME_KEY] ?? {});
      if (fail.set) throw new Error('gravação quebrou');
      return inner.setKeys(data);
    },
    getCreds: inner.getCreds,
    setCreds: inner.setCreds,
    clear: inner.clear,
  };
  return { store, inner, calls, fail };
}

function warnLog() {
  const warns: string[] = [];
  const log: Pick<Logger, 'event'> = { event: (event) => void warns.push(event.message) };
  return { log, warns };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('ContactBook: escrita em lote', () => {
  it('grava o nome observado após o debounce, num único setKeys', async () => {
    const { store, calls } = spyStore();
    const book = new ContactBook({ store });
    book.observe({ id: ALICE, name: 'Alice', phone: null });
    book.observe({ id: BOB, name: 'Bob', phone: null });
    expect(calls.set).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls.set).toEqual([{ [ALICE]: 'Alice', [BOB]: 'Bob' }]);
  });

  it('sincronização com N contatos vira um único setKeys', async () => {
    const { store, calls } = spyStore();
    const book = new ContactBook({ store });
    const list = Array.from({ length: 500 }, (_, i) => ({
      id: `55119000${String(i).padStart(5, '0')}@s.whatsapp.net`,
      notify: `Pessoa ${i}`,
    }));
    learnContacts(list, book);
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls.set).toHaveLength(1);
    expect(Object.keys(calls.set[0] ?? {})).toHaveLength(500);
  });

  it('observar de novo com o mesmo nome não suja nada', async () => {
    const { store, calls } = spyStore();
    const book = new ContactBook({ store });
    book.observe({ id: ALICE, name: 'Alice', phone: null });
    await vi.advanceTimersByTimeAsync(2000);
    book.observe({ id: ALICE, name: 'Alice', phone: null });
    await vi.advanceTimersByTimeAsync(5000);
    await book.flush();
    expect(calls.set).toHaveLength(1);
  });

  it('o apelido LID ↔ telefone também é gravado', async () => {
    const { store, calls } = spyStore();
    const book = new ContactBook({ store });
    book.observe({ id: BOB_LID, name: 'Bob', phone: '5521922220000' });
    await book.flush();
    expect(calls.set).toEqual([{ [BOB_LID]: 'Bob', [BOB]: 'Bob' }]);
  });

  it('falha de setKeys avisa e mantém o lote para a próxima gravação', async () => {
    const { store, calls, fail } = spyStore();
    const { log, warns } = warnLog();
    const book = new ContactBook({ store, log });
    fail.set = true;
    book.observe({ id: ALICE, name: 'Alice', phone: null });
    await book.flush();
    expect(warns).toHaveLength(1);
    fail.set = false;
    book.observe({ id: BOB, name: 'Bob', phone: null });
    await book.flush();
    expect(calls.set.at(-1)).toEqual({ [BOB]: 'Bob', [ALICE]: 'Alice' });
  });

  it('o lote devolvido não sobrescreve um nome mais novo', async () => {
    const { store, calls, fail } = spyStore();
    const book = new ContactBook({ store, log: warnLog().log });
    fail.set = true;
    book.observe({ id: ALICE, name: 'Alice', phone: null });
    const failing = book.flush();
    book.observe({ id: ALICE, name: 'Alice Nova', phone: null });
    await failing;
    fail.set = false;
    await book.flush();
    expect(calls.set.at(-1)).toEqual({ [ALICE]: 'Alice Nova' });
  });

  it('reset descarta o lote pendente: o flush atrasado não ressuscita nomes', async () => {
    const { store, calls, inner } = spyStore();
    const book = new ContactBook({ store });
    book.observe({ id: ALICE, name: 'Alice', phone: null });
    book.reset();
    await inner.clear();
    await vi.advanceTimersByTimeAsync(5000);
    await book.flush();
    expect(calls.set).toHaveLength(0);
    expect(await inner.getKeys(NAME_KEY, [ALICE])).toEqual({});
    expect(book.nameOf(ALICE)).toBeNull();
  });
});

describe('ContactBook: leitura lazy', () => {
  it('um livro novo sobre o mesmo store resolve o nome, inclusive pelo apelido', async () => {
    const { store } = spyStore();
    const first = new ContactBook({ store });
    first.observe({ id: BOB_LID, name: 'Bob', phone: '5521922220000' });
    await first.flush();

    const second = new ContactBook({ store });
    expect(await second.nameFor(BOB_LID, env)).toBe('Bob');
    expect(await new ContactBook({ store }).nameFor(BOB, env)).toBe('Bob');
  });

  it('nome lido do store não gera contact.updated: a primeira vez ainda conta (ADR 0045)', async () => {
    const { store } = spyStore();
    const first = new ContactBook({ store });
    first.observe({ id: ALICE, name: 'Alice', phone: null });
    await first.flush();
    const second = new ContactBook({ store });
    await second.nameFor(ALICE, env);
    expect(second.observe({ id: ALICE, name: 'Alice', phone: null })).toEqual({
      id: ALICE,
      name: 'Alice',
    });
  });

  it('o cache negativo evita o segundo getKeys do mesmo id', async () => {
    const { store, calls } = spyStore();
    const book = new ContactBook({ store });
    expect(await book.nameFor(ALICE, env)).toBeNull();
    expect(await book.nameFor(ALICE, env)).toBeNull();
    expect(calls.get).toHaveLength(1);
  });

  it('observar o id invalida o cache negativo', async () => {
    const { store } = spyStore();
    const book = new ContactBook({ store });
    await book.nameFor(ALICE, env);
    book.observe({ id: ALICE, name: 'Alice', phone: null });
    expect(await book.nameFor(ALICE, env)).toBe('Alice');
  });

  it('leituras concorrentes do mesmo id fazem um único getKeys', async () => {
    const { store, calls } = spyStore();
    const book = new ContactBook({ store });
    await Promise.all([
      book.nameFor(ALICE, env),
      book.nameFor(ALICE, env),
      book.nameFor(ALICE, env),
    ]);
    expect(calls.get).toHaveLength(1);
  });

  it('consulta o id e o telefone par num único getKeys', async () => {
    const { store, calls } = spyStore();
    const book = new ContactBook({ store });
    await book.nameFor(BOB_LID, fullEnv);
    expect(calls.get).toEqual([[BOB_LID, BOB]]);
  });

  it('falha de getKeys devolve null, avisa e deixa tentar de novo', async () => {
    const { store, calls, fail } = spyStore();
    const { log, warns } = warnLog();
    const first = new ContactBook({ store });
    first.observe({ id: ALICE, name: 'Alice', phone: null });
    await first.flush();

    const book = new ContactBook({ store, log });
    fail.get = true;
    expect(await book.nameFor(ALICE, env)).toBeNull();
    expect(warns).toHaveLength(1);
    fail.get = false;
    expect(await book.nameFor(ALICE, env)).toBe('Alice');
    expect(calls.get).toHaveLength(2);
  });

  it('reação (e o withName que o voto, o apagamento e o grupo usam) de quem só existe no store saem com nome', async () => {
    const { store } = spyStore();
    const first = new ContactBook({ store });
    first.observe({ id: ALICE, name: 'Alice', phone: null });
    await first.flush();
    const book = new ContactBook({ store });

    const reaction = await toReaction(
      {
        key: { id: 'M1', remoteJid: ALICE, fromMe: false },
        reaction: { key: { id: 'R1', remoteJid: ALICE, fromMe: false }, text: '👍' },
      },
      fullEnv,
      book,
    );
    expect(reaction?.sender.name).toBe('Alice');
    expect((await book.withName({ id: ALICE, name: null, phone: null }, fullEnv)).name).toBe(
      'Alice',
    );
  });
});

describe('BaileysTransport: nomes persistidos', () => {
  function setup() {
    const { store, calls, inner } = spyStore();
    const driver = new FakeDriver();
    const log = {
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      event: vi.fn(),
      child: () => log,
    };
    const transport = new BaileysTransport(
      { pairing: 'qr', driver },
      { session: 'default', auth: store, log: log as unknown as Logger },
    );
    return { driver, transport, calls, inner };
  }

  it('disconnect() grava o que está pendente', async () => {
    const { driver, transport, calls } = setup();
    await transport.connect();
    driver.last.emit('contacts.upsert', [{ id: ALICE, notify: 'Alice' }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.set).toHaveLength(0);
    await transport.disconnect();
    expect(calls.set).toEqual([{ [ALICE]: 'Alice' }]);
  });

  it('logged-out descarta o lote pendente: o clear() não é desfeito', async () => {
    const { driver, transport, calls, inner } = setup();
    await transport.connect();
    driver.last.emit('contacts.upsert', [{ id: ALICE, notify: 'Alice' }]);
    await vi.advanceTimersByTimeAsync(0);
    driver.last.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: boom(DisconnectReason.loggedOut), date: new Date() },
    });
    await inner.clear();
    await vi.advanceTimersByTimeAsync(5000);
    await transport.disconnect();
    expect(calls.set).toHaveLength(0);
    expect(await inner.getKeys(NAME_KEY, [ALICE])).toEqual({});
  });
});

describe('ContactBook: nome da agenda', () => {
  it('não é gravado no store', async () => {
    const { store, calls } = spyStore();
    const book = new ContactBook({ store });
    learnContacts([{ id: ALICE, name: 'Minha amiga' }], book);
    await book.flush();
    expect(calls.set).toEqual([]);
    expect(book.nameOf(ALICE)).toBe('Minha amiga');
  });

  it('depois de um restart, o pushName gravado vence o nome da agenda', async () => {
    const { store } = spyStore();
    const first = new ContactBook({ store });
    first.observe({ id: ALICE, name: 'Alice', phone: '5511911110000' });
    await first.flush();

    const second = new ContactBook({ store });
    learnContacts([{ id: ALICE, name: 'Minha amiga' }], second);
    expect(await second.nameFor(ALICE, env)).toBe('Alice');
  });

  it('sem nada gravado, a agenda ainda serve de último recurso', async () => {
    const { store } = spyStore();
    const book = new ContactBook({ store });
    learnContacts([{ id: ALICE, name: 'Minha amiga' }], book);
    expect(await book.nameFor(ALICE, env)).toBe('Minha amiga');
  });

  it('pushName visto depois toma o lugar da agenda e passa a ser gravado', async () => {
    const { store, calls } = spyStore();
    const book = new ContactBook({ store });
    learnContacts([{ id: ALICE, name: 'Minha amiga' }], book);
    book.observe({ id: ALICE, name: 'Alice', phone: '5511911110000' });
    await book.flush();
    expect(calls.set).toEqual([{ [ALICE]: 'Alice' }]);
    expect(await book.nameFor(ALICE, env)).toBe('Alice');
  });
});
