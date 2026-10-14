// Esperas persistidas (ADR 0098, #90): o passo com `persist: true` grava a espera no storage do
// kernel, e o boot seguinte a restaura. Cada "restart" aqui é um bot novo sobre o mesmo storage,
// que sobrevive ao `stop()` (o `close` do storage do teste não apaga nada).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { command } from '#commands/command.ts';
import type { WaitRecord } from '#conversations/conversations.ts';
import type { Chat } from '#message/types.ts';
import { definePlugin } from '#plugin/define.ts';
import type { PluginDefinition } from '#plugin/types.ts';
import { createMemoryStorage } from '#storage/memory.ts';
import { kernelStorage } from '#storage/namespace.ts';
import type { Collection, StoragePort } from '#storage/types.ts';
import { type Bot, type BotConfig, createBot } from './bot.ts';
import {
  type LogLine,
  message,
  RecordingTransport,
  recordingLogger,
  sentTexts,
} from './harness.test-support.ts';

const bots: Bot[] = [];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  for (const created of bots.splice(0)) await stop(created);
  vi.useRealTimers();
});

async function stop(bot: Bot): Promise<void> {
  const stopped = bot.stop().catch(() => undefined);
  await vi.runAllTimersAsync();
  await stopped;
}

/** Storage que sobrevive ao `stop()` do bot, como um banco entre dois processos. */
function durableStorage(): StoragePort {
  const inner = createMemoryStorage();
  return {
    forNamespace: (namespace) => inner.forNamespace(namespace),
    authState: (session) => inner.authState(session),
    close: async () => undefined,
  };
}

const waits = (storage: StoragePort): Collection<WaitRecord> =>
  kernelStorage(storage, 'conversations').collection<WaitRecord>('waits');

interface NotasOptions {
  readonly persist?: boolean;
  readonly step?: string;
  readonly ttlMs?: number;
  readonly heard?: string[];
}

/** `!notas` pergunta o aluno; o passo responde com o `data` e encerra. */
function notas(options: NotasOptions = {}): PluginDefinition {
  const step = options.step ?? 'aluno';
  return definePlugin({
    name: 'notas',
    version: '1.0.0',
    engine: '>=0.0.0',
    setup(ctx) {
      ctx.commands.add(
        command({
          name: 'notas',
          run: async (c) => {
            await c.reply('De qual aluno?');
            c.expectReply(step, {
              data: { ano: '2026' },
              ...(options.ttlMs !== undefined && { ttlMs: options.ttlMs }),
            });
          },
        }),
      );
      ctx.conversations.define(step, (c) => c.reply(`Notas de ${c.text} (${c.step})`), {
        persist: options.persist ?? true,
      });
      ctx.events.on('message', (c) => {
        options.heard?.push(c.message.text ?? '');
      });
    },
  });
}

/** `!cadastro` abre uma espera de 1 minuto cujo passo tem `onExpire` (ADR 0097). */
function cadastro(): PluginDefinition {
  return definePlugin({
    name: 'cadastro',
    version: '1.0.0',
    engine: '>=0.0.0',
    setup(ctx) {
      ctx.commands.add(
        command({
          name: 'cadastro',
          run: (c) => {
            c.expectReply('nome', { data: { etapa: 1 }, ttlMs: 60_000 });
          },
        }),
      );
      ctx.conversations.define('nome', (c) => c.reply(`Oi, ${c.text}`), {
        persist: true,
        onExpire: (c) =>
          c.reply(
            `Encerrei: ${c.sender.id} em ${c.chat.id}/${c.chat.tenantId ?? '-'} ` +
              `(${JSON.stringify(c.data)})`,
          ),
      });
    },
  });
}

/**
 * Como o `cadastro`, com espera de 1 segundo, mas o `setup` do reload espera `gate`: o teste age
 * com o plugin no meio do reload. As mensagens citam o número do `setup` que as definiu.
 */
function lento(gate: Promise<void>): PluginDefinition {
  let setups = 0;
  return definePlugin({
    name: 'cadastro',
    version: '1.0.0',
    engine: '>=0.0.0',
    async setup(ctx) {
      const setup = ++setups;
      if (setup > 1) await gate;
      ctx.commands.add(
        command({
          name: 'cadastro',
          run: (c) => {
            c.expectReply('nome', { ttlMs: 1_000 });
          },
        }),
      );
      ctx.conversations.define('nome', (c) => c.reply(`Oi, ${c.text} (${setup})`), {
        persist: true,
        onExpire: (c) => c.reply(`Encerrei (${setup})`),
      });
    },
  });
}

interface Started {
  readonly bot: Bot;
  readonly transport: RecordingTransport;
  readonly lines: LogLine[];
}

async function boot(
  storage: StoragePort,
  plugins: PluginDefinition[],
  extra: Partial<BotConfig> = {},
): Promise<Started> {
  const transport = new RecordingTransport();
  const logger = recordingLogger();
  const bot = createBot({
    transport,
    logger,
    env: {},
    storage,
    plugins,
    outbound: { globalIntervalMs: 0, chatIntervalMs: 0 },
    ...extra,
  });
  bots.push(bot);
  await bot.start();
  return { bot, transport, lines: logger.lines };
}

async function say(started: Started, text: string): Promise<void> {
  started.transport.emit('message', message(text));
  await started.bot.settled();
}

const orphanWarnings = (lines: readonly LogLine[]): LogLine[] =>
  lines.filter((line) => line.level === 'warn' && line.message.includes('espera descartada'));

describe('Bot: esperas persistidas (ADR 0098)', () => {
  it('a espera de passo com persist sobrevive ao restart sobre o mesmo storage', async () => {
    const storage = durableStorage();
    const first = await boot(storage, [notas()]);
    await say(first, '!notas');
    await stop(first.bot);

    const second = await boot(storage, [notas()]);
    await say(second, 'Maria');

    expect(sentTexts(second.transport)).toEqual(['Notas de Maria (aluno)']);
    await stop(second.bot);
    // Respondida, a espera sai do storage: o terceiro boot não a vê.
    expect(await waits(storage).find()).toEqual([]);
  });

  it('sem persist, o restart perde a espera, como antes', async () => {
    const storage = durableStorage();
    const first = await boot(storage, [notas({ persist: false })]);
    await say(first, '!notas');
    await stop(first.bot);
    expect(await waits(storage).find()).toEqual([]);

    const heard: string[] = [];
    const second = await boot(storage, [notas({ persist: false, heard })]);
    await say(second, 'Maria');

    expect(sentTexts(second.transport)).toEqual([]);
    expect(heard).toEqual(['Maria']);
  });

  it('grava o registro versionado com vencimento absoluto, o chat e o contato sem claims', async () => {
    vi.setSystemTime(new Date('2026-10-13T12:00:00Z'));
    const storage = durableStorage();
    const started = await boot(storage, [notas({ ttlMs: 60_000 })]);
    const chat: Chat = { id: 'web:a:1', isGroup: false, tenantId: 'escola-a' };
    const incoming = message('!notas', { sender: { claims: { papel: 'aluno' } } });
    started.transport.emit('message', { ...incoming, chat });
    await started.bot.settled();
    await stop(started.bot);

    const [record] = await waits(storage).find();
    expect(record).toEqual({
      id: expect.any(String),
      v: 1,
      chatId: 'web:a:1',
      senderId: 'user@test',
      chat: { id: 'web:a:1', isGroup: false, tenantId: 'escola-a' },
      sender: { id: 'user@test', name: 'Usuária', phone: null },
      plugin: 'notas',
      step: 'aluno',
      data: { ano: '2026' },
      expiresAt: Date.parse('2026-10-13T12:01:00Z'),
    });
  });

  it('a espera que venceu com o bot fora expira no boot e sai do storage', async () => {
    const storage = durableStorage();
    const first = await boot(storage, [notas({ ttlMs: 60_000 })]);
    await say(first, '!notas');
    await stop(first.bot);

    vi.advanceTimersByTime(2 * 60_000);
    const heard: string[] = [];
    const second = await boot(storage, [notas({ heard })]);
    await say(second, 'Maria');

    expect(sentTexts(second.transport)).toEqual([]);
    expect(heard).toEqual(['Maria']);
    // Expirar não é órfã: sem aviso, como a expiração com o bot no ar (ADR 0060).
    expect(orphanWarnings(second.lines)).toEqual([]);
    await stop(second.bot);
    expect(await waits(storage).find()).toEqual([]);
  });

  it('a que venceu com o bot fora dispara o onExpire no boot, com chat e data restaurados', async () => {
    const storage = durableStorage();
    const first = await boot(storage, [cadastro()]);
    const chat: Chat = { id: 'web:a:1', isGroup: false, tenantId: 'escola-a' };
    first.transport.emit('message', { ...message('!cadastro'), chat });
    await first.bot.settled();
    await stop(first.bot);

    vi.advanceTimersByTime(2 * 60_000);
    const second = await boot(storage, [cadastro()]);
    await second.bot.settled();

    expect(second.transport.sent.map((sent) => sent.chatId)).toEqual(['web:a:1']);
    expect(sentTexts(second.transport)).toEqual([
      'Encerrei: user@test em web:a:1/escola-a ({"etapa":1})',
    ]);
    await stop(second.bot);
    expect(await waits(storage).find()).toEqual([]);
  });

  it('a restaurada ainda válida dispara o onExpire quando vence, pelo timer normal', async () => {
    const storage = durableStorage();
    const first = await boot(storage, [cadastro()]);
    await say(first, '!cadastro');
    await stop(first.bot);

    vi.advanceTimersByTime(20_000);
    const second = await boot(storage, [cadastro()]);
    await vi.advanceTimersByTimeAsync(39_000);
    await second.bot.settled();
    expect(sentTexts(second.transport)).toEqual([]);

    await vi.advanceTimersByTimeAsync(1_000);
    await second.bot.settled();
    expect(sentTexts(second.transport)).toEqual([
      'Encerrei: user@test em chat@test/- ({"etapa":1})',
    ]);
  });

  it('o tempo fora do ar conta: a restaurada vale só o que faltava', async () => {
    const storage = durableStorage();
    const ana = { sender: { id: 'ana@test' } };
    const bia = { sender: { id: 'bia@test' } };
    const first = await boot(storage, [notas({ ttlMs: 10 * 60_000 })]);
    first.transport.emit('message', message('!notas', ana));
    first.transport.emit('message', message('!notas', bia));
    await first.bot.settled();
    await stop(first.bot);

    vi.advanceTimersByTime(4 * 60_000);
    const heard: string[] = [];
    const second = await boot(storage, [notas({ heard })]);
    // Faltam 6 minutos: aos 5, a espera ainda vale.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    second.transport.emit('message', message('Maria', ana));
    await second.bot.settled();
    // Passados os 6, já venceu.
    await vi.advanceTimersByTimeAsync(60_000 + 1);
    second.transport.emit('message', message('Joana', bia));
    await second.bot.settled();

    expect(sentTexts(second.transport)).toEqual(['Notas de Maria (aluno)']);
    expect(heard).toEqual(['Joana']);
  });

  it('a espera de passo que não existe mais é descartada com warn e sai do storage', async () => {
    const storage = durableStorage();
    const first = await boot(storage, [notas()]);
    await say(first, '!notas');
    await stop(first.bot);

    // Versão nova do plugin: o passo foi renomeado.
    const heard: string[] = [];
    const second = await boot(storage, [notas({ step: 'aluno-v2', heard })]);
    await say(second, 'Maria');

    expect(heard).toEqual(['Maria']);
    expect(orphanWarnings(second.lines)).toEqual([
      expect.objectContaining({
        fields: expect.objectContaining({ plugin: 'notas', step: 'aluno' }),
      }),
    ]);
    await stop(second.bot);
    expect(await waits(storage).find()).toEqual([]);
  });

  it('a espera de plugin que não carregou é descartada com warn', async () => {
    const storage = durableStorage();
    const first = await boot(storage, [notas()]);
    await say(first, '!notas');
    await stop(first.bot);

    // Outro plugin com passo persistido sobe; o `notas` fica desligado.
    const other = definePlugin({
      name: 'outro',
      version: '1.0.0',
      engine: '>=0.0.0',
      setup(ctx) {
        ctx.conversations.define('x', () => undefined, { persist: true });
      },
    });
    const second = await boot(storage, [notas(), other], { disabledPlugins: ['notas'] });

    expect(orphanWarnings(second.lines)).toHaveLength(1);
    await stop(second.bot);
    expect(await waits(storage).find()).toEqual([]);
  });

  it('o reload do plugin mantém a espera persistida', async () => {
    const storage = durableStorage();
    const started = await boot(storage, [notas()]);
    await say(started, '!notas');

    await started.bot.plugins.reload('notas');
    await say(started, 'Maria');

    expect(sentTexts(started.transport)).toEqual(['De qual aluno?', 'Notas de Maria (aluno)']);
    expect(orphanWarnings(started.lines)).toEqual([]);
  });

  it('a espera que vence no meio do reload expira com o passo do setup novo', async () => {
    const storage = durableStorage();
    const gate = Promise.withResolvers<void>();
    const started = await boot(storage, [lento(gate.promise)], {
      timeouts: { setupMs: 600_000 },
    });
    await say(started, '!cadastro');

    const reloading = started.bot.plugins.reload('cadastro');
    // O timer dispara com o plugin entre o `removePlugin` e o `setup` novo: sem passo definido.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sentTexts(started.transport)).toEqual([]);

    gate.resolve();
    await reloading;
    await started.bot.settled();

    expect(sentTexts(started.transport)).toEqual(['Encerrei (2)']);
    expect(orphanWarnings(started.lines)).toEqual([]);
    await stop(started.bot);
    expect(await waits(storage).find()).toEqual([]);
  });

  it('a resposta que chega no meio do reload não apaga a espera persistida', async () => {
    const storage = durableStorage();
    const gate = Promise.withResolvers<void>();
    const started = await boot(storage, [lento(gate.promise)], {
      timeouts: { setupMs: 600_000 },
    });
    await say(started, '!cadastro');

    const reloading = started.bot.plugins.reload('cadastro');
    await vi.advanceTimersByTimeAsync(0);
    started.transport.emit('message', message('Maria'));
    await vi.advanceTimersByTimeAsync(0);

    gate.resolve();
    await reloading;
    await say(started, 'Joana');

    // Sem passo, ninguém tratava "Maria"; a espera seguiu para o plugin recarregado.
    expect(sentTexts(started.transport)).toEqual(['Oi, Joana (2)']);
    expect(orphanWarnings(started.lines)).toEqual([]);
    await stop(started.bot);
    expect(await waits(storage).find()).toEqual([]);
  });

  it('o reload cujo setup novo falha descarta a espera persistida com warn', async () => {
    const storage = durableStorage();
    let setups = 0;
    const flaky = definePlugin({
      name: 'notas',
      version: '1.0.0',
      engine: '>=0.0.0',
      setup(ctx) {
        setups++;
        if (setups > 1) throw new Error('setup quebrou');
        ctx.commands.add(
          command({
            name: 'notas',
            run: (c) => {
              c.expectReply('aluno');
            },
          }),
        );
        ctx.conversations.define('aluno', () => undefined, { persist: true });
      },
    });
    const started = await boot(storage, [flaky]);
    await say(started, '!notas');

    await started.bot.plugins.reload('notas');

    expect(orphanWarnings(started.lines)).toHaveLength(1);
    await stop(started.bot);
    expect(await waits(storage).find()).toEqual([]);
  });

  it('o reload tira a espera sem persist, como antes', async () => {
    const storage = durableStorage();
    const heard: string[] = [];
    const started = await boot(storage, [notas({ persist: false, heard })]);
    await say(started, '!notas');

    await started.bot.plugins.reload('notas');
    await say(started, 'Maria');

    expect(heard).toEqual(['Maria']);
  });

  it('desligar o plugin remove a espera persistida, também do storage', async () => {
    const storage = durableStorage();
    const heard: string[] = [];
    const started = await boot(storage, [notas({ heard })]);
    await say(started, '!notas');

    await started.bot.plugins.disable('notas');
    await started.bot.plugins.enable('notas');
    await say(started, 'Maria');

    expect(sentTexts(started.transport)).toEqual(['De qual aluno?']);
    expect(heard).toEqual(['Maria']);
    await stop(started.bot);
    expect(await waits(storage).find()).toEqual([]);
  });

  it('o comando digitado troca a espera persistida: fica um registro só', async () => {
    const storage = durableStorage();
    const started = await boot(storage, [notas()]);
    await say(started, '!notas');
    await say(started, '!notas');
    await stop(started.bot);

    // A segunda espera trocou a primeira: um registro só.
    expect(await waits(storage).find()).toHaveLength(1);
  });

  it('registro de versão desconhecida fica intocado; o malformado sai', async () => {
    const storage = durableStorage();
    const future = { v: 2, chat: 'c', sender: 's', formato: 'novo' };
    await waits(storage).insert(future as unknown as WaitRecord);
    await waits(storage).insert({ v: 1, chatId: 'c' } as unknown as WaitRecord);

    const started = await boot(storage, [notas()]);
    await stop(started.bot);

    expect(await waits(storage).find()).toEqual([{ id: expect.any(String), ...future }]);
  });

  it('com dois registros para a mesma pessoa, vale o de vencimento mais tardio', async () => {
    const storage = durableStorage();
    const base = {
      v: 1,
      chatId: 'chat@test',
      senderId: 'user@test',
      chat: { id: 'chat@test', isGroup: false },
      sender: { id: 'user@test', name: null, phone: null },
      plugin: 'notas',
      data: null,
    };
    const now = Date.now();
    await waits(storage).insert({ ...base, step: 'aluno', expiresAt: now + 60_000 });
    await waits(storage).insert({ ...base, step: 'aluno', expiresAt: now + 120_000 });

    const started = await boot(storage, [notas()]);
    await vi.advanceTimersByTimeAsync(90_000);
    await say(started, 'Maria');

    expect(sentTexts(started.transport)).toEqual(['Notas de Maria (aluno)']);
    await stop(started.bot);
    expect(await waits(storage).find()).toEqual([]);
  });

  it('falha ao gravar vai ao log em warn, e a conversa segue em memória', async () => {
    const inner = durableStorage();
    const storage: StoragePort = {
      ...inner,
      forNamespace(namespace) {
        const scoped = inner.forNamespace(namespace);
        if (namespace !== '$conversations') return scoped;
        return {
          kv: scoped.kv,
          collection: <T extends WaitRecord>() =>
            ({
              insert: () => Promise.reject(new Error('banco fora')),
              get: () => Promise.resolve(undefined),
              find: () => Promise.resolve([]),
              update: () => Promise.resolve(0),
              delete: () => Promise.resolve(0),
            }) as unknown as Collection<T>,
        } as typeof scoped;
      },
    };
    const started = await boot(storage, [notas()]);
    await say(started, '!notas');
    await say(started, 'Maria');

    expect(sentTexts(started.transport)).toEqual(['De qual aluno?', 'Notas de Maria (aluno)']);
    await stop(started.bot);
    expect(started.lines).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: 'conversas: falha ao gravar espera no storage',
      }),
    );
  });

  it('falha ao ler no boot vai ao log em error, e o bot sobe', async () => {
    const inner = durableStorage();
    const storage: StoragePort = {
      ...inner,
      forNamespace(namespace) {
        const scoped = inner.forNamespace(namespace);
        if (namespace !== '$conversations') return scoped;
        return {
          kv: scoped.kv,
          collection: <T extends WaitRecord>() =>
            ({ find: () => Promise.reject(new Error('banco fora')) }) as unknown as Collection<T>,
        } as typeof scoped;
      },
    };
    const started = await boot(storage, [notas()]);

    expect(started.bot.state).toBe('running');
    expect(started.lines).toContainEqual(
      expect.objectContaining({ level: 'error', message: expect.stringContaining('conversas:') }),
    );
  });

  it('bot sem passo persistido não lê o storage de conversas no boot', async () => {
    const inner = durableStorage();
    const opened: string[] = [];
    const storage: StoragePort = {
      ...inner,
      forNamespace(namespace) {
        opened.push(namespace);
        return inner.forNamespace(namespace);
      },
    };
    const started = await boot(storage, [notas({ persist: false })]);
    await say(started, '!notas');
    await say(started, 'Maria');

    expect(opened).not.toContain('$conversations');
  });
});
