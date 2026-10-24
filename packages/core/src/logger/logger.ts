// Implementação do `Logger` sobre pino (M1-14). O pino fica só aqui dentro: a API pública fala
// `Logger`/`LoggerOptions`, para trocar a implementação sem quebrar plugins.

import { type Logger as PinoLogger, pino, stdSerializers } from 'pino';
import { redactPersonalIds } from './personal-id.ts';
import { prettyDestination } from './pretty.ts';
import type { SecretSource } from './secrets.ts';
import type { LogFields, Logger, LogLevel } from './types.ts';

/** Para onde vão as linhas JSON (uma por chamada, terminada em `\n`). */
export interface LogDestination {
  write(line: string): void;
}

export interface LoggerOptions {
  /** Nível mínimo emitido. Padrão: `'info'`. */
  readonly level?: LogLevel;
  /**
   * `'json'` (padrão): uma linha JSON por chamada, para agregador. Com `'pretty'`, cada linha
   * sai como `14:03:22 INFO  [plugin] mensagem chave=valor`, com o `err` (stack e causas) nas
   * linhas seguintes, e colorida quando vai ao stdout de um terminal. Os segredos são censurados
   * igual.
   */
  readonly format?: 'json' | 'pretty';
  /** Destino das linhas. Padrão: stdout do processo. */
  readonly destination?: LogDestination;
  /** Campos presentes em toda linha deste logger e dos filhos (ex.: `{ app: 'meu-bot' }`). */
  readonly bindings?: LogFields;
  /**
   * Caminhos de campos trocados por `[REDACTED]`, na sintaxe de redação do pino
   * (`'password'`, `'config.apiKey'`, `'*.token'`). Pega o campo pelo nome, onde quer que o
   * valor esteja.
   */
  readonly redact?: readonly string[];
  /**
   * Valores secretos (ex.: campos `secret` da config) trocados por `[REDACTED]` em qualquer
   * lugar da linha: mensagem, campos, bindings, `err.message`/`err.stack`. Pega o valor, sob
   * qualquer nome de campo. Valores com menos de `MIN_SECRET_LENGTH` caracteres são ignorados.
   * Uma `SecretSource` (ex.: `createSecretSet()`) é consultada a cada linha: segredos descobertos
   * depois da criação do logger — como os da config de plugin, resolvida no setup e no reload —
   * também são censurados.
   */
  readonly secrets?: readonly string[] | SecretSource;
}

const CENSOR = '[REDACTED]';

/**
 * Tamanho mínimo de um segredo para ser censurado no log. A censura troca o valor onde ele
 * aparecer na linha: um segredo de 1 a 3 caracteres (`"1"`, `"on"`) apagaria pedaços de todo
 * log, e um valor tão curto não protege nada de qualquer forma.
 */
export const MIN_SECRET_LENGTH = 4;

/**
 * Logger estruturado em JSON. `child({ plugin })` e `child({ chat })` acumulam contexto; um
 * `Error` nos campos, sob qualquer chave, é serializado com `type`, `message`, `stack` e `cause`.
 * A convenção é o campo `err`.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const destination = withPersonalIdsRedacted(
    withSecretsCensored(formatted(options), options.secrets),
  );
  const root = pino(
    {
      level: options.level ?? 'info',
      // `errWithCause` mantém a `cause` como objeto estruturado (com stack própria), em vez de
      // concatená-la na mensagem como o serializer padrão.
      serializers: { err: stdSerializers.errWithCause },
      // Formato do ADR 0118: nível em texto e hora ISO UTC, que o Loki e o Grafana leem sem
      // pipeline extra. `pid` e `hostname` saem: quem identifica a origem são os bindings base.
      base: null,
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }), log: serializeErrors },
      ...(options.redact && options.redact.length > 0
        ? { redact: { paths: [...options.redact], censor: CENSOR } }
        : {}),
    },
    destination,
  );
  return wrap(options.bindings ? root.child(withoutReserved(options.bindings, true)) : root);
}

// O serializer do pino só cobre o `err`. Um `Error` sob outra chave (`{ error }`) sairia `{}`,
// porque message e stack não são enumeráveis; aqui ele ganha o mesmo tratamento do `err`. Copia
// os campos só quando há o que trocar: o objeto é de quem chamou.
function serializeErrors(fields: Record<string, unknown>): Record<string, unknown> {
  let out = fields;
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'err' || !(value instanceof Error)) continue;
    if (out === fields) out = { ...fields };
    out[key] = stdSerializers.errWithCause(value);
  }
  return out;
}

// O `pretty` converte a linha que sai da censura: os segredos são achados no JSON, onde a forma
// escapada é conhecida, e o texto final nunca os vê.
function formatted(options: LoggerOptions): LogDestination | undefined {
  if (options.format !== 'pretty') return options.destination;
  // Cor só no stdout padrão: um destino próprio (arquivo, teste) recebe texto puro.
  return prettyDestination(options.destination ?? pino.destination(1), !options.destination);
}

// Censura por valor no texto já serializado: pega o segredo onde quer que ele apareça, o que a
// redação por caminho não garante (ex.: token interpolado na mensagem ou no `err.message`).
// Custo só em linha emitida, e só quando há segredo configurado.
function withSecretsCensored(
  destination: LogDestination | undefined,
  secrets: readonly string[] | SecretSource | undefined,
): LogDestination | undefined {
  if (secrets === undefined) return destination;
  let source: SecretSource | undefined;
  let needles: string[] = [];
  if ('version' in secrets) source = secrets;
  else needles = toNeedles(secrets);
  // Lista fixa e vazia: nada a censurar, nem precisa embrulhar o destino. Com fonte viva, sempre
  // embrulha, porque um segredo pode aparecer depois.
  if (!source && needles.length === 0) return destination;
  let seen = -1;
  // Sem destino explícito, o padrão é o mesmo do pino: stdout.
  const target = destination ?? pino.destination(1);
  return {
    write(line: string): void {
      if (source && source.version !== seen) {
        seen = source.version;
        needles = toNeedles(source.values());
      }
      let censored = line;
      for (const needle of needles) censored = censored.replaceAll(needle, CENSOR);
      target.write(censored);
    },
  };
}

// Redação de reserva do ADR 0119: JID e telefone que escaparem (em campo, mensagem ou `err`)
// saem como `[REDACTED]`. Sempre ligada: id pessoal não tem opção de ficar no log.
function withPersonalIdsRedacted(destination: LogDestination | undefined): LogDestination {
  const target = destination ?? pino.destination(1);
  return { write: (line) => target.write(redactPersonalIds(line)) };
}

// O segredo aparece na linha na forma escapada do JSON; o mais longo primeiro, para um segredo
// que contém outro ser trocado inteiro.
function toNeedles(secrets: readonly string[]): string[] {
  return secrets
    .filter((secret) => secret.length >= MIN_SECRET_LENGTH)
    .map((secret) => JSON.stringify(secret).slice(1, -1))
    .sort((a, b) => b.length - a.length);
}

// Chaves que o pino já escreve na linha: repeti-las nos campos geraria chave duplicada no JSON, e
// quem lê fica com a última (o `level` é rótulo de stream no Loki, então errar aqui custa caro).
// Nos bindings o `event` também é reservado: quem o escreve é o `logger.event`.
// Checagem direta com `in`, sem iterar um Set: o caminho comum não aloca nada, nem iterador.
export function withoutReserved(fields: LogFields, bindings = false): LogFields {
  const reserved =
    'level' in fields || 'time' in fields || 'msg' in fields || (bindings && 'event' in fields);
  if (!reserved) return fields;
  return Object.fromEntries(
    Object.entries(fields).filter(
      ([key]) =>
        key !== 'level' && key !== 'time' && key !== 'msg' && !(bindings && key === 'event'),
    ),
  );
}

function wrap(log: PinoLogger): Logger {
  // Sem campos, chama o pino só com a mensagem: evita alocar um objeto vazio por linha. Em nível
  // desabilitado o método do pino já é um no-op, então nada é serializado.
  return {
    get level(): LogLevel {
      return log.level as LogLevel;
    },
    trace: (message, fields) =>
      fields ? log.trace(withoutReserved(fields), message) : log.trace(message),
    debug: (message, fields) =>
      fields ? log.debug(withoutReserved(fields), message) : log.debug(message),
    info: (message, fields) =>
      fields ? log.info(withoutReserved(fields), message) : log.info(message),
    warn: (message, fields) =>
      fields ? log.warn(withoutReserved(fields), message) : log.warn(message),
    error: (message, fields) =>
      fields ? log.error(withoutReserved(fields), message) : log.error(message),
    fatal: (message, fields) =>
      fields ? log.fatal(withoutReserved(fields), message) : log.fatal(message),
    // O nível é checado antes: em nível desabilitado, nem o objeto com o `event` é alocado.
    event: (event, fields) => {
      if (log.isLevelEnabled(event.level))
        log[event.level](
          { ...(fields && withoutReserved(fields)), event: event.name },
          event.message,
        );
    },
    child: (bindings) => wrap(log.child(withoutReserved(bindings, true))),
  };
}

// Descarta a linha: é o propósito do logger no-op.
const noop = (): void => {
  return;
};

// Objeto congelado e sem recurso: compartilhá-lo não cria estado global mutável.
const NOOP_LOGGER: Logger = Object.freeze({
  level: 'silent',
  trace: noop,
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
  fatal: noop,
  event: noop,
  child: (): Logger => NOOP_LOGGER,
});

/** Logger que descarta tudo, sem custo: para testes e como padrão quando ninguém configurou. */
export function createNoopLogger(): Logger {
  return NOOP_LOGGER;
}
