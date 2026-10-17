// Sinal `log` dos observadores (ADR 0109): envolve o Logger raiz do bot, e não o destino do
// pino, para cobrir também o `config.logger` do app. Sem observador de `log`, a linha passa
// direto: nada é montado.

import type { Observers } from '#observers/observers.ts';
import { MIN_SECRET_LENGTH } from './logger.ts';
import type { SecretSource } from './secrets.ts';
import type { LogFields, Logger, LogLevel } from './types.ts';

const CENSOR = '[REDACTED]';
const MAX_DEPTH = 6;
type EmitLevel = Exclude<LogLevel, 'silent'>;
const LEVELS: readonly LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

export interface LogSignalTap {
  /** Devolve um logger que, além de logar, alimenta o sinal `log`. */
  wrap(logger: Logger): Logger;
  /** Roda `fn` sem que o que ela logar vire sinal (log de erro do próprio observador). */
  quiet<T>(fn: () => T): T;
}

export function createLogSignalTap(observers: Observers, secrets: SecretSource): LogSignalTap {
  // Um flag por bot: o observador roda síncrono, então tudo que ele (ou o `plugin.error` dele)
  // loga durante a chamada cai aqui e não volta ao sinal.
  let emitting = false;
  let seen = -1;
  let needles: string[] = [];

  const quiet = <T>(fn: () => T): T => {
    const before = emitting;
    emitting = true;
    try {
      return fn();
    } finally {
      emitting = before;
    }
  };

  const censor = (text: string): string => {
    if (secrets.version !== seen) {
      seen = secrets.version;
      needles = secrets
        .values()
        .filter((secret) => secret.length >= MIN_SECRET_LENGTH)
        .sort((a, b) => b.length - a.length);
    }
    let out = text;
    for (const needle of needles) out = out.replaceAll(needle, CENSOR);
    return out;
  };

  // Cópia com os segredos trocados; `Error` vira objeto simples, como o `err` do log.
  const clean = (value: unknown, depth: number, path: object[]): unknown => {
    if (typeof value === 'string') return censor(value);
    if (typeof value !== 'object' || value === null) return value;
    if (path.includes(value)) return '[Circular]';
    if (depth >= MAX_DEPTH) return '[Object]';
    const next = [...path, value];
    if (Array.isArray(value)) return value.map((item) => clean(item, depth + 1, next));
    if (value instanceof Error) {
      return {
        type: value.name,
        message: censor(value.message),
        ...(value.stack !== undefined && { stack: censor(value.stack) }),
        ...(value.cause !== undefined && { cause: clean(value.cause, depth + 1, next) }),
      };
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, clean(item, depth + 1, next)]),
    );
  };

  const wrap = (logger: Logger, bindings: LogFields): Logger => {
    const at =
      (level: EmitLevel) =>
      (message: string, fields?: LogFields): void => {
        logger[level](message, fields);
        if (emitting || !observers.has('log')) return;
        // O nível é lido a cada linha: o do logger do app pode mudar em runtime.
        const min = LEVELS.indexOf(logger.level);
        if (min < 0 || LEVELS.indexOf(level) < min) return; // `silent` não está em LEVELS
        const time = Date.now();
        quiet(() =>
          observers.emit('log', {
            level,
            time,
            message: censor(message),
            fields: clean({ ...bindings, ...fields }, 0, []) as LogFields,
          }),
        );
      };
    return {
      get level(): LogLevel {
        return logger.level;
      },
      trace: at('trace'),
      debug: at('debug'),
      info: at('info'),
      warn: at('warn'),
      error: at('error'),
      fatal: at('fatal'),
      child: (more) => wrap(logger.child(more), { ...bindings, ...more }),
    };
  };

  return { wrap: (logger) => wrap(logger, {}), quiet };
}
