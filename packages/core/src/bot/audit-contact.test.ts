// ADR 0140: o remetente como titular da auditoria no fluxo de mensagem e o `kernel.command.*`
// gravado pelo core para comando com papel restrito.

import { afterEach, describe, expect, it } from 'vitest';
import type { AuditEvent } from '#audit/types.ts';
import { command } from '#commands/command.ts';
import { PSEUDONYM_RE } from '#logger/pseudonym.ts';
import { definePlugin } from '#plugin/define.ts';
import type { PluginContext } from '#plugin/types.ts';
import { createMemoryStorage } from '#storage/memory.ts';
import { type Bot, createBot } from './bot.ts';
import { deferred, message, RecordingTransport, recordingLogger } from './harness.test-support.ts';

const KEY = Buffer.alloc(32, 7).toString('base64');
const OWNER = 'owner@test';

const bots: Bot[] = [];
afterEach(async () => {
  for (const bot of bots.splice(0)) await bot.stop().catch(() => undefined);
});

function setup(register: (ctx: PluginContext) => void | Promise<void>) {
  const inner = createMemoryStorage();
  // O stop fecha o storage; o teste lê depois dele.
  const storage = { ...inner, close: async () => undefined };
  const transport = new RecordingTransport();
  const ctxs: PluginContext[] = [];
  const bot = createBot({
    transport,
    logger: recordingLogger(),
    env: { BRIDGER_SECRET_KEY: KEY },
    storage,
    owners: [{ id: OWNER }],
    adminPlugins: ['luma'],
    plugins: [
      definePlugin({
        name: 'luma',
        version: '1.0.0',
        engine: '>=0.0.0',
        async setup(ctx) {
          ctxs.push(ctx);
          await register(ctx);
        },
      }),
    ],
  });
  bots.push(bot);
  const rows = async (): Promise<AuditEvent[]> =>
    (await storage
      .forNamespace('$audit')
      .collection('audit')
      .find({ orderBy: 'seq' })) as unknown as AuditEvent[];
  /** Entrega as mensagens, espera o tratamento e para o bot (o stop drena a auditoria). */
  const send = async (...texts: (string | { text: string; sender: string })[]) => {
    await bot.start();
    for (const item of texts) {
      const { text, sender } =
        typeof item === 'string' ? { text: item, sender: 'user@test' } : item;
      transport.emit('message', message(text, { sender: { id: sender } }));
    }
    await bot.settled();
  };
  const ctx = () => ctxs[0] as PluginContext;
  return { bot, transport, rows, send, ctx };
}

const ofPlugin = (events: AuditEvent[]) => events.filter((e) => e.action.startsWith('luma.'));
const ofCommands = (events: AuditEvent[]) =>
  events.filter((e) => e.action.startsWith('kernel.command.'));

describe('ator contact no fluxo de mensagem', () => {
  it('record do plugin num comando e num listener sai com o contato pseudonimizado e via', async () => {
    const { bot, rows, send } = setup((ctx) => {
      ctx.commands.add(
        command({
          name: 'limpar',
          run: () => ctx.audit.record({ action: 'luma.history.clear' }),
        }),
      );
      ctx.events.on('message', () => ctx.audit.record({ action: 'luma.message.seen' }));
    });
    await send('!limpar', 'oi');
    await bot.stop();

    const events = ofPlugin(await rows());
    expect(events.map((e) => e.action)).toEqual(['luma.history.clear', 'luma.message.seen']);
    for (const event of events) {
      expect(event.actor).toMatchObject({ kind: 'contact', transport: 'test' });
      expect(event).toMatchObject({ via: 'luma', actorKind: 'contact' });
      const { id } = event.actor as { id: string };
      expect(id).toMatch(PSEUDONYM_RE);
      expect(id).not.toContain('user@test');
      expect(event.actorId).toBe(id);
    }
    // Mesmo remetente, mesmo pseudônimo.
    expect(events[0]?.actorId).toBe(events[1]?.actorId);
  });

  it('comando background mantém o contato depois que o chat é liberado', async () => {
    const gate = deferred();
    const pinged = deferred();
    const { bot, transport, rows } = setup((ctx) => {
      ctx.commands.add(
        command({
          name: 'baixar',
          background: true,
          run: async () => {
            await gate.promise;
            ctx.audit.record({ action: 'luma.download.done' });
          },
        }),
      );
      ctx.commands.add(command({ name: 'ping', run: () => undefined }));
      ctx.events.on('command', (e) => {
        if (e.payload.name === 'ping') pinged.resolve();
      });
    });
    await bot.start();
    transport.emit('message', message('!baixar'));
    transport.emit('message', message('!ping'));
    // O chat já atendeu o `!ping`; o `run` do `!baixar` grava só agora.
    await pinged.promise;
    gate.resolve();
    await bot.settled();
    await bot.stop();

    const [done] = ofPlugin(await rows());
    expect(done).toMatchObject({
      action: 'luma.download.done',
      actorKind: 'contact',
      via: 'luma',
    });
  });

  it('boot e job do scheduler (mesmo agendado por comando) continuam com o plugin', async () => {
    const ran = deferred();
    const { bot, rows, send } = setup(async (ctx) => {
      ctx.audit.record({ action: 'luma.boot.ready' });
      ctx.scheduler.on('lembrar', () => {
        ctx.audit.record({ action: 'luma.reminder.fire' });
        ran.resolve();
      });
      ctx.commands.add(
        command({
          name: 'lembrar',
          run: async () => {
            await ctx.scheduler.at(Date.now(), 'lembrar');
          },
        }),
      );
    });
    await send('!lembrar');
    await ran.promise;
    await bot.stop();

    const events = ofPlugin(await rows());
    expect(events.map((e) => [e.action, e.actor, e.via])).toEqual([
      ['luma.boot.ready', { kind: 'plugin', name: 'luma' }, undefined],
      ['luma.reminder.fire', { kind: 'plugin', name: 'luma' }, undefined],
    ]);
  });
});

describe('kernel.command.* para papel restrito', () => {
  it('owner: run com success/error e denied para quem não é dono, sem os argumentos', async () => {
    const { bot, rows, send } = setup((ctx) => {
      ctx.commands.add(command({ name: 'reboot', role: 'owner', run: () => undefined }));
      ctx.commands.add(
        command({
          name: 'quebra',
          role: 'owner',
          run: () => {
            throw new Error('falhou');
          },
        }),
      );
    });
    await send(
      { text: '!reboot senha-secreta', sender: OWNER },
      { text: '!quebra', sender: OWNER },
      '!reboot senha-secreta',
    );
    await bot.stop();

    const events = ofCommands(await rows());
    expect(events.map((e) => [e.action, e.outcome, e.details])).toEqual([
      [
        'kernel.command.run',
        'success',
        { plugin: 'luma', command: 'reboot', invokedAs: 'reboot', role: 'owner' },
      ],
      [
        'kernel.command.run',
        'error',
        { plugin: 'luma', command: 'quebra', invokedAs: 'quebra', role: 'owner' },
      ],
      [
        'kernel.command.denied',
        'denied',
        { plugin: 'luma', command: 'reboot', invokedAs: 'reboot', role: 'owner' },
      ],
    ]);
    for (const event of events) {
      expect(event.actorKind).toBe('contact');
      // Gravação do core: sem `via`.
      expect(event.via).toBeUndefined();
      expect(JSON.stringify(event)).not.toContain('senha-secreta');
      // Conversa privada: o alvo é o pseudônimo do chat, não o id cru.
      expect(event.target?.type).toBe('chat');
      expect(event.target?.id).toMatch(PSEUDONYM_RE);
    }
    // O dono e a outra pessoa são atores diferentes.
    expect(events[0]?.actorId).not.toBe(events[2]?.actorId);
  });

  it('papel custom entra; everyone, group-admin e recusa por accepts não', async () => {
    const { bot, rows, send } = setup((ctx) => {
      ctx.roles.define('moderador', (c) => c.message.sender.id === 'mod@test');
      ctx.commands.add(command({ name: 'ban', role: 'moderador', run: () => undefined }));
      ctx.commands.add(command({ name: 'ping', run: () => undefined }));
      ctx.commands.add(command({ name: 'prefixo2', role: 'group-admin', run: () => undefined }));
      ctx.commands.add(
        command({ name: 'figura', role: 'moderador', accepts: ['image'], run: () => undefined }),
      );
    });
    await send(
      { text: '!ban', sender: 'mod@test' },
      '!ban',
      '!ping',
      { text: '!prefixo2', sender: OWNER },
      '!prefixo2',
      { text: '!figura', sender: 'mod@test' },
    );
    await bot.stop();

    expect(ofCommands(await rows()).map((e) => [e.action, e.details?.['command']])).toEqual([
      ['kernel.command.run', 'ban'],
      ['kernel.command.denied', 'ban'],
    ]);
  });

  it('actorKind contact na consulta devolve os eventos do chat', async () => {
    const { bot, ctx, send } = setup((c) => {
      c.commands.add(command({ name: 'reboot', role: 'owner', run: () => undefined }));
    });
    await send('!reboot');
    // O stop drena a fila; o `close` do storage do teste não fecha nada, então a consulta lê.
    await bot.stop();
    const page = await ctx().audit.query({ actorKind: 'contact' });
    expect(page.events.map((e) => e.action)).toEqual(['kernel.command.denied']);
  });
});
