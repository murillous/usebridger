import { describe, expect, it } from 'vitest';
import { defineLogEvent } from './define-event.ts';
import {
  createLogger,
  createNoopLogger,
  type LogDestination,
  type LoggerOptions,
} from './logger.ts';

const TIMEOUT = defineLogEvent({
  name: 'command.timeout',
  level: 'error',
  message: 'comando rejeitou depois do prazo',
});

function capture(options: Omit<LoggerOptions, 'destination'> = {}) {
  const raw: string[] = [];
  const destination: LogDestination = { write: (line) => raw.push(line) };
  const log = createLogger({ ...options, destination });
  const lines = (): Record<string, unknown>[] =>
    raw.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { log, raw, lines };
}

describe('createLogger', () => {
  it('emite uma linha JSON com nível, mensagem e campos', () => {
    const { log, lines } = capture();
    log.info('mensagem recebida', { chat: 'c1', size: 3 });
    expect(lines()).toEqual([
      expect.objectContaining({ level: 'info', msg: 'mensagem recebida', chat: 'c1', size: 3 }),
    ]);
  });

  it('usa info como nível padrão', () => {
    const { log, lines } = capture();
    expect(log.level).toBe('info');
    log.debug('não sai');
    log.info('sai');
    expect(lines().map((line) => line['msg'])).toEqual(['sai']);
  });

  it('respeita o nível configurado', () => {
    const { log, lines } = capture({ level: 'warn' });
    expect(log.level).toBe('warn');
    log.info('não sai');
    log.warn('aviso');
    log.error('erro');
    expect(lines().map((line) => line['msg'])).toEqual(['aviso', 'erro']);
  });

  it('nível trace emite tudo e silent não emite nada', () => {
    const verbose = capture({ level: 'trace' });
    verbose.log.trace('t');
    verbose.log.fatal('f');
    expect(verbose.lines().map((line) => line['level'])).toEqual(['trace', 'fatal']);

    const silent = capture({ level: 'silent' });
    silent.log.fatal('nada');
    expect(silent.raw).toEqual([]);
  });

  it('não serializa campos em nível desabilitado', () => {
    const { log, raw } = capture({ level: 'error' });
    const fields = {
      get caro(): never {
        throw new Error('campo lido em nível desabilitado');
      },
    };
    log.debug('ignorado', fields);
    expect(raw).toEqual([]);
  });

  it('logs de plugin carregam plugin e chatId', () => {
    const { log, lines } = capture();
    // Como o Bot (M1-16) vai montar: logger do plugin, depois o do chat da mensagem.
    const pluginLog = log.child({ plugin: 'clima' });
    pluginLog.child({ chatId: '123@g.us' }).info('previsão enviada', { cidade: 'Recife' });
    pluginLog.info('setup concluído');

    expect(lines()).toEqual([
      expect.objectContaining({
        plugin: 'clima',
        chatId: '123@g.us',
        cidade: 'Recife',
        msg: 'previsão enviada',
      }),
      expect.objectContaining({ plugin: 'clima', msg: 'setup concluído' }),
    ]);
    expect(lines()[1]).not.toHaveProperty('chatId');
  });

  it('filho herda o nível do pai', () => {
    const { log } = capture({ level: 'error' });
    expect(log.child({ plugin: 'x' }).level).toBe('error');
  });

  it('acrescenta os bindings base a toda linha, inclusive dos filhos', () => {
    const { log, lines } = capture({ bindings: { app: 'meu-bot' } });
    log.info('raiz');
    log.child({ plugin: 'p' }).info('filho');
    expect(lines()).toEqual([
      expect.objectContaining({ app: 'meu-bot', msg: 'raiz' }),
      expect.objectContaining({ app: 'meu-bot', plugin: 'p', msg: 'filho' }),
    ]);
  });

  it('serializa err com message, stack e cause', () => {
    const { log, lines } = capture();
    const cause = new Error('timeout no socket');
    log.error('falha ao enviar', { err: new Error('envio falhou', { cause }) });

    const err = lines()[0]?.['err'] as Record<string, unknown>;
    expect(err).toMatchObject({ type: 'Error', message: 'envio falhou' });
    expect(err['stack']).toEqual(expect.stringContaining('envio falhou'));
    expect(err['cause']).toMatchObject({ type: 'Error', message: 'timeout no socket' });
    expect((err['cause'] as Record<string, unknown>)['stack']).toEqual(
      expect.stringContaining('timeout no socket'),
    );
  });

  it('serializa um Error sob qualquer chave como o err, sem mexer nos campos recebidos', () => {
    const { log, lines } = capture();
    const cause = new Error('disco cheio');
    const fields = { error: new Error('flush falhou', { cause }), outro: new TypeError('x'), n: 1 };
    log.error('flush de métricas falhou', fields);

    const line = lines()[0] as Record<string, Record<string, unknown>>;
    expect(line['error']).toMatchObject({ type: 'Error', message: 'flush falhou' });
    expect(line['error']?.['stack']).toEqual(expect.stringContaining('flush falhou'));
    expect(line['error']?.['cause']).toMatchObject({ message: 'disco cheio' });
    expect(line['outro']).toMatchObject({ type: 'TypeError', message: 'x' });
    expect(line['outro']?.['stack']).toEqual(expect.stringContaining('TypeError: x'));
    expect(line).toMatchObject({ n: 1 });
    expect(fields.error).toBeInstanceOf(Error);
  });

  it('censura segredos no Error sob qualquer chave', () => {
    const secret = 'sk-segredo-123';
    const { log, raw, lines } = capture({ secrets: [secret] });
    log.error('falhou', { error: new Error(`401 para a chave ${secret}`) });

    expect(raw[0]).not.toContain(secret);
    expect(lines()[0]?.['error']).toMatchObject({ message: '401 para a chave [REDACTED]' });
  });

  it('redact troca os caminhos configurados por [REDACTED]', () => {
    const { log, raw, lines } = capture({ redact: ['config.apiKey', '*.token'] });
    log.info('config carregada', {
      config: { apiKey: 'sk-segredo', modelo: 'x' },
      auth: { token: 'tok-segredo' },
    });

    expect(lines()[0]).toMatchObject({
      config: { apiKey: '[REDACTED]', modelo: 'x' },
      auth: { token: '[REDACTED]' },
    });
    expect(raw.join('')).not.toMatch(/sk-segredo|tok-segredo/);
  });

  it('secrets censura o valor em qualquer lugar da linha', () => {
    const secret = 'sk-"abc"\\123';
    const { log, raw, lines } = capture({ secrets: [secret, ''], bindings: { k: secret } });
    const child = log.child({ plugin: 'ia' });
    child.info(`chamando a API com ${secret}`, { qualquerNome: secret, nested: [{ v: secret }] });
    child.error('falhou', { err: new Error(`401 para a chave ${secret}`) });

    expect(raw).toHaveLength(2);
    for (const line of raw) {
      expect(line).not.toContain('sk-');
      expect(line).toContain('[REDACTED]');
    }
    // A linha continua JSON válido depois da censura.
    expect(lines()[0]).toMatchObject({
      msg: 'chamando a API com [REDACTED]',
      qualquerNome: '[REDACTED]',
      nested: [{ v: '[REDACTED]' }],
      k: '[REDACTED]',
    });
  });

  it('secrets ignora valores curtos demais para censurar (MIN_SECRET_LENGTH)', () => {
    const { log, raw } = capture({ secrets: ['on', 'abc', 'abcd'] });
    log.info('on abc abcd');
    expect(raw[0]).toContain('"msg":"on abc [REDACTED]"');
  });

  it('secrets troca inteiro o segredo que contém outro', () => {
    const { log, raw } = capture({ secrets: ['abc', 'abcdef'] });
    log.info('abcdef');
    expect(raw[0]).toContain('"msg":"[REDACTED]"');
  });
});

describe('createLogger: formato e eventos (ADR 0118)', () => {
  it('nível em texto, hora ISO UTC e sem pid/hostname', () => {
    const { log, lines } = capture();
    log.warn('aviso');
    const [line] = lines();
    expect(line?.['level']).toBe('warn');
    expect(line?.['time']).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(line).not.toHaveProperty('pid');
    expect(line).not.toHaveProperty('hostname');
  });

  it('event emite no nível do evento, com a mensagem fixa e o nome em event', () => {
    const { log, lines } = capture({ bindings: { bot: 'principal' } });
    log.child({ plugin: 'ai' }).event(TIMEOUT, { command: 'imagem', durationMs: 30012 });
    expect(lines()).toEqual([
      expect.objectContaining({
        level: 'error',
        msg: 'comando rejeitou depois do prazo',
        event: 'command.timeout',
        bot: 'principal',
        plugin: 'ai',
        command: 'imagem',
        durationMs: 30012,
      }),
    ]);
  });

  it('event sem campos e com err', () => {
    const { log, lines } = capture();
    log.event(TIMEOUT);
    log.event(TIMEOUT, { err: new Error('prazo') });
    const [plain, failed] = lines();
    expect(plain).toMatchObject({
      event: 'command.timeout',
      msg: 'comando rejeitou depois do prazo',
    });
    expect(failed?.['err']).toMatchObject({ type: 'Error', message: 'prazo' });
  });

  it('o campo event passado nos campos não substitui o nome do evento', () => {
    const { log, lines } = capture();
    log.event(TIMEOUT, { event: 'outro.nome' });
    expect(lines()[0]?.['event']).toBe('command.timeout');
  });

  it('event em nível desabilitado não lê os campos', () => {
    const { log, raw } = capture({ level: 'fatal' });
    const fields = {
      get caro(): never {
        throw new Error('campo lido em nível desabilitado');
      },
    };
    log.event(TIMEOUT, fields);
    expect(raw).toEqual([]);
  });

  it('event passa pela censura de segredos', () => {
    const { log, raw } = capture({ secrets: ['sk-segredo-123'] });
    log.event(TIMEOUT, { command: 'sk-segredo-123' });
    expect(raw[0]).not.toContain('sk-segredo-123');
  });
});

describe('createLogger: chaves reservadas', () => {
  const count = (raw: string, key: string): number => raw.split(`"${key}":`).length - 1;

  it('log.event descarta level, time e msg dos campos: cada chave aparece uma vez', () => {
    const { log, raw, lines } = capture();
    log.event(TIMEOUT, { level: 'fake', time: 'x', msg: 'y', chat: 'c1' });
    const line = raw[0] as string;
    for (const key of ['level', 'time', 'msg', 'event']) expect(count(line, key)).toBe(1);
    expect(lines()[0]).toMatchObject({ level: 'error', msg: TIMEOUT.message, chat: 'c1' });
  });

  it('os métodos por nível também descartam level, time e msg', () => {
    const { log, raw, lines } = capture();
    log.warn('aviso', { level: 'fake', time: 'x', msg: 'y', chat: 'c1' });
    const line = raw[0] as string;
    for (const key of ['level', 'time', 'msg']) expect(count(line, key)).toBe(1);
    expect(lines()[0]).toMatchObject({ level: 'warn', msg: 'aviso', chat: 'c1' });
  });

  it('child descarta event, level, time e msg dos bindings', () => {
    const { log, raw, lines } = capture();
    log.child({ event: 'x', level: 'fake', time: 't', msg: 'y', chat: 'c1' }).event(TIMEOUT);
    const line = raw[0] as string;
    for (const key of ['level', 'time', 'msg', 'event']) expect(count(line, key)).toBe(1);
    expect(lines()[0]).toMatchObject({ level: 'error', event: 'command.timeout', chat: 'c1' });
  });

  it('bindings do createLogger também descartam level: a chave aparece uma vez', () => {
    const { log, raw } = capture({ bindings: { level: 'x', app: 'bot' } });
    log.info('oi');
    expect(count(raw[0] as string, 'level')).toBe(1);
    expect(JSON.parse(raw[0] as string)).toMatchObject({ level: 'info', app: 'bot' });
  });
});

describe('createNoopLogger', () => {
  it('descarta tudo e devolve a si mesmo como filho', () => {
    const log = createNoopLogger();
    expect(log.level).toBe('silent');
    expect(() => log.fatal('nada', { err: new Error('x') })).not.toThrow();
    expect(() => log.event(TIMEOUT, { err: new Error('x') })).not.toThrow();
    expect(log.child({ plugin: 'p' })).toBe(log);
  });

  it('não lê os campos recebidos', () => {
    const log = createNoopLogger();
    const fields = {
      get caro(): never {
        throw new Error('campo lido no logger no-op');
      },
    };
    log.info('x', fields);
    log.child(fields).error('y', fields);
  });
});
