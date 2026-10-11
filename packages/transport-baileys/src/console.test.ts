import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { routeLibsignalConsole } from './console.ts';
import type { ILogger } from './logger.ts';

// O desvio decide pelo caminho do chamador: o falso fica num `node_modules/libsignal` de verdade.
let dir: string;
let libsignal: { say(method: 'info' | 'warn' | 'error', ...args: unknown[]): void };

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bridger-libsignal-'));
  const src = join(dir, 'node_modules', 'libsignal', 'src');
  await mkdir(src, { recursive: true });
  const file = join(src, 'session_record.mjs');
  await writeFile(file, 'export function say(method, ...args) { console[method](...args); }\n');
  libsignal = await import(pathToFileURL(file).href);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function recordingLogger() {
  const lines: [string, unknown, string | undefined][] = [];
  const at =
    (level: string) =>
    (obj: unknown, msg?: string): void => {
      lines.push([level, obj, msg]);
    };
  const logger = {
    level: 'trace',
    child: () => logger,
    trace: at('trace'),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
  } as ILogger;
  return { logger, lines };
}

const saved = { info: console.info, warn: console.warn, error: console.error };
let info: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>;
let error: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>;

beforeEach(() => {
  info = vi.fn<(...args: unknown[]) => void>();
  error = vi.fn<(...args: unknown[]) => void>();
  console.info = info;
  console.error = error;
});

afterEach(() => {
  Object.assign(console, saved);
});

describe('routeLibsignalConsole', () => {
  it('desvia o console do libsignal para o logger em debug, só com o texto', () => {
    const { logger, lines } = recordingLogger();
    const release = routeLibsignalConsole(logger);
    libsignal.say('info', 'Closing session:', { rootKey: 'segredo', chainKey: 'segredo' });
    release();
    expect(lines).toEqual([['debug', { source: 'libsignal' }, 'Closing session:']]);
    expect(JSON.stringify(lines)).not.toContain('segredo');
    expect(info).not.toHaveBeenCalled();
  });

  it('console.error do libsignal vira warn', () => {
    const { logger, lines } = recordingLogger();
    const release = routeLibsignalConsole(logger);
    libsignal.say('error', 'V1 session storage migration error: registrationId', 42);
    release();
    expect(lines).toEqual([
      ['warn', { source: 'libsignal' }, 'V1 session storage migration error: registrationId'],
    ]);
    expect(error).not.toHaveBeenCalled();
  });

  it('o console do resto do processo passa intacto', () => {
    const { logger, lines } = recordingLogger();
    const release = routeLibsignalConsole(logger);
    console.info('do app', { a: 1 });
    release();
    expect(lines).toEqual([]);
    expect(info).toHaveBeenCalledWith('do app', { a: 1 });
  });

  it('desligado o último desvio, o console volta ao original', () => {
    const first = recordingLogger();
    const second = recordingLogger();
    const releaseFirst = routeLibsignalConsole(first.logger);
    const releaseSecond = routeLibsignalConsole(second.logger);
    libsignal.say('info', 'Opening session:');
    releaseSecond();
    releaseSecond();
    expect(console.info).not.toBe(info);
    libsignal.say('info', 'Removing old closed session:');
    releaseFirst();
    expect(console.info).toBe(info);
    libsignal.say('info', 'Closing session:');
    expect(second.lines.map(([, , msg]) => msg)).toEqual(['Opening session:']);
    expect(first.lines.map(([, , msg]) => msg)).toEqual(['Removing old closed session:']);
    expect(info).toHaveBeenCalledWith('Closing session:');
  });
});
