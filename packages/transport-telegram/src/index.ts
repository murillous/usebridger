// Entry `@usebridger/transport-telegram`: a fábrica que o app passa em `createBot({ transport })`
// (ADR 0033, ADR 0137). A classe fica interna: o transport precisa das dependências do bot.

import type { Transport, TransportDeps } from '@usebridger/core/adapter';
import { Bot } from 'grammy';
import { TelegramTransport } from './transport.ts';

export interface TelegramOptions {
  /** Token do bot, do BotFather (`123456:ABC-DEF...`). */
  readonly token: string;
  /**
   * Recebe por webhook em vez de long polling. Exige `http` no `createBot` (ADR 0072). A `url`
   * é a pública, `https`, que chega à rota `<basePath>/webhook` do transport.
   */
  readonly webhook?: {
    readonly url: string;
    /** 1 a 256 caracteres de `A-Z a-z 0-9 _ -`; o Telegram o devolve em cada chamada. */
    readonly secretToken: string;
  };
}

/** Formato do token do BotFather: o ID do bot, dois-pontos e o segredo. */
const TOKEN = /^\d+:[\w-]+$/;

/** Alfabeto e tamanho que o `setWebhook` aceita no `secret_token`. */
const SECRET_TOKEN = /^[\w-]{1,256}$/;

export function telegram(options: TelegramOptions): (deps: TransportDeps) => Transport {
  const { token } = options;
  // Na fábrica, um token malformado vira `BotConfigError` no `createBot`, antes de qualquer
  // conexão. Sem o token na mensagem: ele é segredo.
  if (typeof token !== 'string' || !TOKEN.test(token)) {
    throw new TypeError('telegram: token inválido; use o token do BotFather (123456:ABC-DEF...)');
  }
  const { webhook } = options;
  if (webhook !== undefined) {
    if (typeof webhook.url !== 'string' || !URL.canParse(webhook.url) || !isHttps(webhook.url)) {
      throw new TypeError('telegram: webhook.url inválida; o Telegram exige uma URL https');
    }
    // Sem o segredo na mensagem. Sem ele qualquer um forjaria updates na rota pública.
    if (typeof webhook.secretToken !== 'string' || !SECRET_TOKEN.test(webhook.secretToken)) {
      throw new TypeError('telegram: webhook.secretToken inválido; use 1 a 256 de A-Z a-z 0-9 _ -');
    }
  }
  return (deps) =>
    new TelegramTransport(
      {
        makeBot: () => new Bot(token),
        fetchFile: (filePath) => fetch(`https://api.telegram.org/file/bot${token}/${filePath}`),
      },
      deps,
      webhook,
    );
}

function isHttps(url: string): boolean {
  return new URL(url).protocol === 'https:';
}
