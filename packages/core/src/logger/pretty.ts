// Formato `pretty` do logger: a linha JSON do pino vira texto para ler no terminal. Converte a
// linha já serializada (e já censurada), em vez de ter um segundo caminho de serialização: os
// segredos e o `err` saem iguais aos do JSON, e o custo fica só na linha emitida.

import { styleText } from 'node:util';
import type { LogDestination } from './logger.ts';

type Style = Parameters<typeof styleText>[0];

const LEVELS: Readonly<Record<number, readonly [label: string, style: Style]>> = {
  10: ['TRACE', 'gray'],
  20: ['DEBUG', 'blue'],
  30: ['INFO ', 'green'],
  40: ['WARN ', 'yellow'],
  50: ['ERROR', 'red'],
  60: ['FATAL', ['bgRed', 'white']],
};

/** Campos que o cabeçalho já mostra ou que não ajudam a ler no terminal. */
const HIDDEN = new Set(['level', 'time', 'pid', 'hostname', 'msg', 'plugin', 'err']);

interface SerializedError {
  readonly type?: string;
  readonly message?: string;
  readonly stack?: string;
  readonly cause?: unknown;
}

/**
 * Embrulha `target` para receber texto legível em vez de JSON. `color` liga as cores ANSI; o
 * `styleText` ainda as desliga com `NO_COLOR` ou quando o stdout não é um terminal.
 */
export function prettyDestination(target: LogDestination, color: boolean): LogDestination {
  const paint = (style: Style, text: string): string =>
    color ? styleText(style, text, { stream: process.stdout }) : text;
  return {
    write(line: string): void {
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // Linha que não é JSON (não deveria acontecer com o pino): sai como veio, sem perder nada.
        target.write(line);
        return;
      }
      target.write(`${formatRecord(record, paint)}\n`);
    },
  };
}

function formatRecord(
  record: Record<string, unknown>,
  paint: (style: Style, text: string) => string,
): string {
  const [label, style] = LEVELS[record['level'] as number] ?? ['?    ', 'white'];
  const parts = [paint('gray', clock(record['time'])), paint(style, label)];
  if (typeof record['plugin'] === 'string') parts.push(paint('cyan', `[${record['plugin']}]`));
  parts.push(String(record['msg'] ?? ''));
  const fields = Object.entries(record)
    .filter(([key]) => !HIDDEN.has(key))
    .map(([key, value]) => paint('gray', `${key}=${formatValue(value)}`));
  let text = [...parts, ...fields].join(' ');
  if (record['err'] !== undefined) text += `\n${indent(formatError(record['err']))}`;
  return text;
}

/** Hora local `HH:MM:SS`; o dia fica de fora, o terminal é para acompanhar ao vivo. */
function clock(time: unknown): string {
  const date = typeof time === 'number' ? new Date(time) : new Date();
  return date.toTimeString().slice(0, 8);
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return /^[^\s"=]+$/.test(value) ? value : JSON.stringify(value);
  return JSON.stringify(value) ?? String(value);
}

/** Stack do erro e as das causas, em sequência; sem stack, `tipo: mensagem` ou o JSON. */
function formatError(err: unknown): string {
  if (typeof err !== 'object' || err === null) return String(err);
  const { type, message, stack, cause } = err as SerializedError;
  const own = stack ?? (message === undefined ? JSON.stringify(err) : `${type}: ${message}`);
  return cause === undefined ? own : `${own}\ncausa: ${formatError(cause)}`;
}

function indent(text: string): string {
  return text.replaceAll(/^/gm, '    ');
}
