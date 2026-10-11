// O Baileys loga no formato do pino (`logger.info(obj, msg)`); o bot, no do core
// (`log.info(msg, fields)`). Este adapter traduz um para o outro, para as linhas do Baileys
// passarem pelo logger do bot, com a censura de segredos dele (ADR 0032).

import type { LogFields, Logger, LogLevel } from '@usebridger/core';
import type { SocketConfig } from 'baileys';

/** Logger que o Baileys aceita; o pacote não exporta o `ILogger` pela entrada principal. */
export type ILogger = SocketConfig['logger'];

type Method = 'trace' | 'debug' | 'info' | 'warn' | 'error';

const RANK: Readonly<Record<LogLevel, number>> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: Number.POSITIVE_INFINITY,
};

/** Valida níveis vindos de fora do sistema de tipos (opção em JS). */
export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && Object.hasOwn(RANK, value);
}

/**
 * `floor` é o nível mínimo das linhas do Baileys, além do nível do bot: vale o mais alto dos
 * dois. Sem ele, só o do bot.
 */
export function toBaileysLogger(log: Logger, floor: LogLevel = 'trace'): ILogger {
  /** O mais alto entre o nível do bot e o piso. */
  const effective = (): LogLevel => (RANK[log.level] >= RANK[floor] ? log.level : floor);
  const write = (method: Method) => {
    const rank = RANK[method];
    return (obj: unknown, msg?: string): void => {
      if (rank < RANK[floor]) return;
      if (typeof obj === 'string') log[method](obj);
      else log[method](msg ?? '', toFields(obj));
    };
  };
  return {
    // O Baileys consulta o nível para pular logs caros; lido a cada vez porque o logger da
    // fábrica só passa a valer no `start()`.
    get level(): string {
      return effective();
    },
    child: (bindings) => toBaileysLogger(log.child(bindings), floor),
    trace: write('trace'),
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
  };
}

function toFields(obj: unknown): LogFields | undefined {
  if (obj instanceof Error) return { err: obj };
  if (typeof obj === 'object' && obj !== null) return obj as LogFields;
  return obj === undefined ? undefined : { value: obj };
}
