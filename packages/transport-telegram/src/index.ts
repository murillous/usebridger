// Entry `@usebridger/transport-telegram`: a fábrica que o app passa em `createBot({ transport })`
// (ADR 0033, ADR 0137). A classe fica interna: o transport precisa das dependências do bot.

import type { Transport, TransportDeps } from '@usebridger/core/adapter';
import { Bot } from 'grammy';
import { TelegramTransport } from './transport.ts';

export interface TelegramOptions {
  /** Token do bot, do BotFather (`123456:ABC-DEF...`). */
  readonly token: string;
}

/** Formato do token do BotFather: o ID do bot, dois-pontos e o segredo. */
const TOKEN = /^\d+:[\w-]+$/;

export function telegram(options: TelegramOptions): (deps: TransportDeps) => Transport {
  const { token } = options;
  // Na fábrica, um token malformado vira `BotConfigError` no `createBot`, antes de qualquer
  // conexão. Sem o token na mensagem: ele é segredo.
  if (typeof token !== 'string' || !TOKEN.test(token)) {
    throw new TypeError('telegram: token inválido; use o token do BotFather (123456:ABC-DEF...)');
  }
  return (deps) =>
    new TelegramTransport(
      {
        makeBot: () => new Bot(token),
        fetchFile: (filePath) => fetch(`https://api.telegram.org/file/bot${token}/${filePath}`),
      },
      deps,
    );
}
