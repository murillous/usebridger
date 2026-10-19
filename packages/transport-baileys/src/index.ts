// Entry `@usebridger/transport-baileys`: a fábrica que o app passa em `createBot({ transport })`
// (ADR 0033). A classe fica interna: o transport precisa das dependências do bot.

import type { LogLevel } from '@usebridger/core';
import type { Transport, TransportDeps } from '@usebridger/core/adapter';
import { Browsers, fetchLatestBaileysVersion, makeWASocket, type WAVersion } from 'baileys';
import { isLogLevel } from './logger.ts';
import { type BaileysDriver, type BaileysPairing, BaileysTransport } from './transport.ts';

export type { BaileysPairing } from './transport.ts';

export interface BaileysOptions {
  /**
   * Como parear quando a sessão não tem credenciais: `'qr'` (padrão) emite `connection.qr`;
   * `{ phone }` pede um código de pareamento para o número (só dígitos, com DDI) e emite
   * `connection.pairing-code`.
   */
  readonly pairing?: BaileysPairing;
  /**
   * Versão do WhatsApp Web a anunciar. Sem ela, o transport busca a mais recente na primeira
   * conexão e, se a busca falhar, usa a que vem com o Baileys.
   */
  readonly version?: WAVersion;
  /**
   * Nível mínimo das linhas do próprio Baileys (sincronização, pre-keys, protocolo), em inglês.
   * Padrão: `'warn'`; o estado da conexão o bot já loga em PT. Use `'debug'` para investigar o
   * Baileys. Vale o mais alto entre este e o nível do bot.
   */
  readonly logLevel?: LogLevel;
}

export function baileys(options: BaileysOptions = {}): (deps: TransportDeps) => Transport {
  const pairing = options.pairing ?? 'qr';
  // Na fábrica, um número inválido vira `BotConfigError` no `createBot`, antes de qualquer
  // conexão.
  if (pairing !== 'qr' && !/^\d{8,15}$/.test(pairing.phone)) {
    throw new TypeError(
      `baileys: pairing.phone deve ter só dígitos, com DDI (ex.: 5511999999999); recebido "${pairing.phone}"`,
    );
  }
  const logLevel = options.logLevel ?? 'warn';
  if (!isLogLevel(logLevel)) {
    throw new TypeError(`baileys: logLevel desconhecido "${String(logLevel)}"`);
  }
  return (deps) =>
    new BaileysTransport({ pairing, logLevel, driver: driver(options.version, deps) }, deps);
}

function driver(fixed: WAVersion | undefined, deps: TransportDeps): BaileysDriver {
  let latest: Promise<WAVersion> | undefined;
  return {
    makeSocket: ({ auth, logger, version, cachedGroupMetadata }) =>
      makeWASocket({
        auth,
        logger,
        version,
        cachedGroupMetadata,
        browser: Browsers.ubuntu('Chrome'),
      }),
    version: () => {
      if (fixed) return Promise.resolve(fixed);
      // Uma busca por transport: a versão não muda entre reconexões do mesmo processo.
      latest ??= fetchLatestBaileysVersion().then(({ version, error }) => {
        if (error !== undefined) {
          deps.log.warn('não deu para buscar a versão do WhatsApp Web; usando a do Baileys', {
            err: error,
          });
        }
        return version;
      });
      return latest;
    },
  };
}
