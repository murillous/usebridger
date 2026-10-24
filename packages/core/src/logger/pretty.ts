// Formato `pretty` do logger: a linha JSON do pino vira texto para ler no terminal. Converte a
// linha já serializada (e já censurada), em vez de ter um segundo caminho de serialização: os
// segredos e o `err` saem iguais aos do JSON, e o custo fica só na linha emitida.

import { styleText } from 'node:util';
import type { LogDestination } from './logger.ts';

type Style = Parameters<typeof styleText>[0];

const LEVELS: Readonly<Record<string, readonly [label: string, style: Style]>> = {
  trace: ['TRACE', 'gray'],
  debug: ['DEBUG', 'blue'],
  info: ['INFO ', 'green'],
  warn: ['WARN ', 'yellow'],
  error: ['ERROR', 'red'],
  fatal: ['FATAL', ['bgRed', 'white']],
};

/**
 * Campos que o cabeçalho já mostra ou que não ajudam a ler no terminal: o `event` é para o
 * agregador, e os bindings base são os mesmos em toda linha (ADR 0118).
 */
const HIDDEN = new Set([
  'level',
  'time',
  'msg',
  'plugin',
  'err',
  'event',
  'service',
  'bot',
  'version',
  'env',
]);

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
  const [label, style] = LEVELS[String(record['level'])] ?? ['?    ', 'white'];
  const parts = [paint('gray', clock(record['time'])), paint(style, label)];
  if (typeof record['plugin'] === 'string') parts.push(paint('cyan', `[${record['plugin']}]`));
  parts.push(String(record['msg'] ?? ''));
  const fields: string[] = [];
  const below: string[] = [];
  if (record['err'] !== undefined) below.push(formatError(record['err']));
  for (const [key, value] of Object.entries(record)) {
    if (HIDDEN.has(key)) continue;
    // Erro sob outra chave (`{ error }`) e texto de várias linhas (a tabela de boot em `report`)
    // vão para as linhas seguintes: numa linha só, escapados, não dá para ler.
    if (isSerializedError(value)) below.push(`${key}: ${formatError(value)}`);
    else if (typeof value === 'string' && value.includes('\n')) below.push(value);
    else fields.push(paint('gray', `${key}=${formatValue(value)}`));
  }
  let text = [...parts, ...fields].join(' ');
  for (const block of below) text += `\n${indent(block)}`;
  return text;
}

/** Hora local `HH:MM:SS`; o dia fica de fora, o terminal é para acompanhar ao vivo. */
function clock(time: unknown): string {
  const date = typeof time === 'string' || typeof time === 'number' ? new Date(time) : new Date();
  return date.toTimeString().slice(0, 8);
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return /^[^\s"=]+$/.test(value) ? value : JSON.stringify(value);
  return JSON.stringify(value) ?? String(value);
}

/** Erro como o `errWithCause` do pino o deixa na linha. */
function isSerializedError(value: unknown): value is SerializedError {
  if (typeof value !== 'object' || value === null) return false;
  const { message, stack } = value as SerializedError;
  return typeof message === 'string' && typeof stack === 'string';
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
