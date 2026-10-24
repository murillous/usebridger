// Contrato de log do rate limit (ADR 0118): `message.rate-limited` com `chat` e `sender`.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Bot, createBot } from './bot.ts';
import { message, RecordingTransport, recordingLogger } from './harness.test-support.ts';

const bots: Bot[] = [];

afterEach(async () => {
  for (const created of bots.splice(0)) await created.stop().catch(() => undefined);
});

describe('message.rate-limited', () => {
  it('sai com event, chat e sender', async () => {
    const transport = new RecordingTransport();
    const logger = recordingLogger();
    const bot = createBot({
      transport,
      logger,
      env: {},
      middlewares: { rateLimit: { max: 1, windowMs: 60_000 } },
    });
    bots.push(bot);
    await bot.start();

    transport.emit('message', message('primeira'));
    transport.emit('message', message('excedeu'));

    await vi.waitFor(() =>
      expect(logger.lines.find((l) => l.fields['event'] === 'message.rate-limited')).toBeDefined(),
    );
    const line = logger.lines.find((l) => l.fields['event'] === 'message.rate-limited');
    expect(line?.fields).toMatchObject({
      event: 'message.rate-limited',
      chat: 'chat@test',
      sender: 'user@test',
    });
    expect(line?.fields).not.toHaveProperty('chatId');
  });
});
