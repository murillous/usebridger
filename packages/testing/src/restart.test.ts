// `restart()` do kit (ADR 0098): o bot novo sobe sobre o mesmo storage, para testar o que
// sobrevive a um deploy, como as esperas de passo com `persist: true`.

import { command, createMemoryStorage, definePlugin, type StoragePort } from '@usebridger/core';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeTransport } from './fake-transport.ts';
import { createTestBot, type TestBot } from './test-bot.ts';
import './matchers.ts';

const bots: TestBot[] = [];

afterEach(async () => {
  for (const bot of bots.splice(0)) await bot.stop();
});

async function track(bot: Promise<TestBot>): Promise<TestBot> {
  const started = await bot;
  bots.push(started);
  return started;
}

const notas = (step = 'aluno') =>
  definePlugin({
    name: 'notas',
    version: '1.0.0',
    engine: '>=0.0.0',
    setup(ctx) {
      ctx.commands.add(
        command({
          name: 'notas',
          run: async (c) => {
            await c.reply('De qual aluno?');
            c.expectReply(step);
          },
        }),
      );
      ctx.conversations.define(step, (c) => c.reply(`Notas de ${c.text}`), { persist: true });
    },
  });

describe('TestBot.restart', () => {
  it('a conversa persistida continua no bot novo', async () => {
    const first = await createTestBot({ plugins: [notas()] });
    await first.receive({ text: '!notas' });

    const second = await track(first.restart());
    await second.receive({ text: 'Maria' });

    expect(second.sent).toContainText('Notas de Maria');
    // Transport novo, criado pelo kit: só os envios do bot novo.
    expect(second.sent).toHaveLength(1);
    expect(first.bot.state).toBe('stopped');
  });

  it('overrides trocam o plugin; a espera do passo que sumiu não responde', async () => {
    const first = await createTestBot({ plugins: [notas()] });
    await first.receive({ text: '!notas' });

    const second = await track(first.restart({ plugins: [notas('aluno-v2')] }));
    await second.receive({ text: 'Maria' });

    expect(second.sent).toHaveLength(0);
  });

  it('o transport passado nas opções é reaproveitado', async () => {
    const transport = new FakeTransport();
    const first = await createTestBot({ transport, plugins: [notas()] });
    const second = await track(first.restart());

    expect(second.transport).toBe(transport);
    expect(transport.connected).toBe(true);
  });

  it('o storage só fecha no stop do último bot', async () => {
    const memory = createMemoryStorage();
    let closed = 0;
    const storage: StoragePort = {
      forNamespace: (namespace) => memory.forNamespace(namespace),
      authState: (session) => memory.authState(session),
      close: async () => {
        closed++;
        await memory.close();
      },
    };
    const first = await createTestBot({ storage });
    const second = await first.restart();
    expect(closed).toBe(0);

    await first.stop();
    expect(closed).toBe(0);
    await second.stop();
    expect(closed).toBe(1);
  });
});
