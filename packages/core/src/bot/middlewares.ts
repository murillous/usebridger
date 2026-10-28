import * as LOG from '#logger/events.ts';
import type { Logger } from '#logger/types.ts';
import { chatFilter } from '#middleware/chat-filter.ts';
import { ignoreBots } from '#middleware/ignore-bots.ts';
import { ignoreSelf } from '#middleware/ignore-self.ts';
import { MiddlewarePipeline } from '#middleware/pipeline.ts';
import { rateLimit } from '#middleware/rate-limit.ts';
import { sanitize } from '#middleware/sanitize.ts';
import type { BotMiddlewaresConfig } from './config.ts';
import type { KernelMessageContext } from './message-context.ts';

export const MIDDLEWARE_PRIORITY = {
  ignoreSelf: 1000,
  ignoreBots: 990,
  chatFilter: 900,
  rateLimit: 800,
  sanitize: 700,
};

/** Pipeline com os middlewares oficiais ligados pela config e os do app. */
export function createPipeline(
  options: BotMiddlewaresConfig,
  timeoutMs: number,
  log: () => Logger,
): MiddlewarePipeline<KernelMessageContext> {
  // Middleware roda dentro da tarefa da fila do chat: sem prazo, um preso seguraria o chat
  // para sempre (ADR 0039).
  const pipeline = new MiddlewarePipeline<KernelMessageContext>({
    timeoutMs,
    onLateError: (error) => log().event(LOG.middlewareLate, { err: error }),
  });
  if (options.ignoreSelf !== false) {
    pipeline.use(ignoreSelf(), { priority: MIDDLEWARE_PRIORITY.ignoreSelf });
  }
  if (options.ignoreBots !== false) {
    pipeline.use(ignoreBots(), { priority: MIDDLEWARE_PRIORITY.ignoreBots });
  }
  if (options.chatFilter) {
    pipeline.use(chatFilter(options.chatFilter), { priority: MIDDLEWARE_PRIORITY.chatFilter });
  }
  if (options.rateLimit) {
    const limit = rateLimit({
      onLimited: (ctx) =>
        log().event(LOG.messageRateLimited, {
          chat: ctx.message.chat.id,
          sender: ctx.message.sender.id,
        }),
      ...options.rateLimit,
    });
    pipeline.use(limit, { priority: MIDDLEWARE_PRIORITY.rateLimit });
  }
  if (options.sanitize !== false) {
    pipeline.use(sanitize(options.sanitize), { priority: MIDDLEWARE_PRIORITY.sanitize });
  }
  for (const entry of options.use ?? []) {
    if (typeof entry === 'function') pipeline.use(entry);
    else pipeline.use(entry.middleware, { priority: entry.priority });
  }
  return pipeline;
}
