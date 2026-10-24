// Validações e montagem do boot do bot (plano §5.3): nome de sessão, transport (instância ou
// fábrica), `connect` e limite de botões. Funções puras, separadas do `createBot`, que cuida do
// ciclo de vida: aqui só se decide se a config é aceitável.

import { CommandConflictError } from '#commands/registry.ts';
import { RoleConflictError } from '#commands/roles.ts';
import { BotConfigError } from '#config/owners.ts';
import { PLUGIN_NAME_PATTERN } from '#plugin/define.ts';
import { ServiceConflictError } from '#services/registry.ts';
import { transportIssues } from '#transport/methods.ts';
import type { Transport, TransportDeps } from '#transport/types.ts';
import type { BotConfig } from './config.ts';

/** Erros de `setup` que derrubam o boot em vez de só ignorar o plugin. */
export const isBootConflict = (error: unknown): boolean =>
  error instanceof CommandConflictError ||
  error instanceof RoleConflictError ||
  error instanceof ServiceConflictError;

/** Nome de sessão no formato de nome de plugin: vira prefixo de namespace no storage. */
export function validateSession(session: string): string {
  if (!PLUGIN_NAME_PATTERN.test(session)) {
    throw new BotConfigError(
      `session deve ser kebab-case minúsculo (ex.: "atendimento"); recebido "${session}"`,
    );
  }
  return session;
}

// Chaves que o logger já escreve ou que o bot põe sozinho (ADR 0118): um binding do app não as
// pode ocupar, senão a linha sai com chave repetida ou com o `bot` trocado.
const RESERVED_LOG_KEYS = ['bot', 'event', 'level', 'time', 'msg'];

/** `logBindings` não pode usar chave reservada do contrato de log. */
export function validateLogBindings(bindings: BotConfig['logBindings']): void {
  const reserved = Object.keys(bindings ?? {}).filter((key) => RESERVED_LOG_KEYS.includes(key));
  if (reserved.length > 0) {
    throw new BotConfigError(
      `logBindings não pode usar chave reservada: ${reserved.map((key) => `"${key}"`).join(', ')}`,
    );
  }
}

/** Instância pronta, ou a que a fábrica monta; fábrica que lança é erro de config. */
export function resolveTransport(
  transport: BotConfig['transport'],
  deps: TransportDeps,
): Transport {
  let resolved: Transport;
  if (typeof transport !== 'function') resolved = transport;
  else {
    try {
      resolved = transport(deps);
    } catch (error) {
      throw new BotConfigError('transport: a fábrica lançou ao montar o transport', {
        cause: error,
      });
    }
  }
  // Capability sem o método dela só falharia quando um plugin a usasse (ADR 0076).
  const issues = transportIssues(resolved);
  if (issues.length > 0) {
    throw new BotConfigError(`transport inválido:\n- ${issues.join('\n- ')}`);
  }
  return resolved;
}

/** `transport.connect()` com um throw síncrono do adapter virando rejeição. */
export function callConnect(transport: Transport): Promise<void> {
  try {
    return transport.connect();
  } catch (error) {
    return Promise.reject(error);
  }
}

/** Máximo de botões por mensagem do transport (`limits.actions`); sem ele, sem limite. */
export function buttonLimit(transport: Transport): number {
  const limit = transport.limits?.actions;
  if (limit === undefined) return Number.POSITIVE_INFINITY;
  if (!(Number.isInteger(limit) && limit >= 1)) {
    throw new RangeError(`limits.actions do transport deve ser inteiro >= 1 (recebido: ${limit})`);
  }
  return limit;
}
