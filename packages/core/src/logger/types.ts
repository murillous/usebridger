// Contrato do logger (M1-14). Plugins e o kernel dependem só desta interface; a implementação
// com pino fica atrás dela, para o core não vazar o pino na API pública.

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';

/** Nível em que uma linha pode sair (`silent` só desliga o logger). */
export type EmitLevel = Exclude<LogLevel, 'silent'>;

/**
 * Dicionário de campos do kernel (ADR 0118): o mesmo nome para a mesma coisa em core, transports e
 * plugins, para filtrar no agregador sem conhecer quem logou. Outros nomes continuam livres.
 */
export interface StandardLogFields {
  /** O erro; serializado com `type`, `message`, `stack` e `cause`. */
  readonly err?: unknown;
  /** Nome estável do evento; quem o preenche é o `log.event`. */
  readonly event?: string;
  /** Nome do app (binding base, via `logBindings`). */
  readonly service?: string;
  /** Sessão do bot (binding base, posto pelo bot). */
  readonly bot?: string;
  /** Versão do app (binding base, via `logBindings`). */
  readonly version?: string;
  /** Ambiente do app, como `production` (binding base, via `logBindings`). */
  readonly env?: string;
  readonly plugin?: string;
  readonly transport?: string;
  /** Id do chat. */
  readonly chat?: string;
  /** Id de quem enviou a mensagem. */
  readonly sender?: string;
  readonly messageId?: string;
  readonly command?: string;
  /** Passo de conversa. */
  readonly step?: string;
  /** Papel (`role`) de comando. */
  readonly role?: string;
  /** Rota HTTP ou do transport. */
  readonly route?: string;
  /** Status de algo (HTTP, plugin, conexão). */
  readonly status?: string | number;
  /** Motivo em texto curto; o erro vai em `err`. */
  readonly reason?: string;
  readonly durationMs?: number;
  /** Id de correlação; reservado para a #232. */
  readonly trace?: string;
}

/** Campos estruturados de uma linha de log (ex.: `{ chat, err }`). */
export type LogFields = StandardLogFields & Readonly<Record<string, unknown>>;

/** Nome de evento: `<área>.<coisa>.<verbo>`, em kebab-case, com pelo menos dois segmentos. */
export type LogEventName = `${string}.${string}`;

/** Evento de log com nível e mensagem fixos (ver `defineLogEvent`). */
export interface LogEvent {
  readonly name: LogEventName;
  readonly level: EmitLevel;
  /** Mensagem para quem lê, sem valores: eles vão nos campos. */
  readonly message: string;
}

export interface Logger {
  readonly level: LogLevel;
  trace(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  fatal(message: string, fields?: LogFields): void;
  /** Emite `event` no nível dele, com `msg` = a mensagem e o campo `event` = o nome. */
  event(event: LogEvent, fields?: LogFields): void;
  /** Logger filho que acrescenta `bindings` (ex.: `{ plugin }`, `{ chat }`) a toda linha. */
  child(bindings: LogFields): Logger;
}
