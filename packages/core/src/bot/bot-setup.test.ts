import { describe, expect, it } from 'vitest';
import { CommandConflictError } from '#commands/registry.ts';
import { RoleConflictError } from '#commands/roles.ts';
import { BotConfigError } from '#config/owners.ts';
import { ServiceConflictError } from '#services/registry.ts';
import type { Transport, TransportDeps } from '#transport/types.ts';
import {
  buttonLimit,
  callConnect,
  isBootConflict,
  resolveTransport,
  validateSession,
} from './bot-setup.ts';
import { RecordingTransport } from './harness.test-support.ts';

const deps = {} as TransportDeps;

/** Transport válido com `limits.actions` configurável. */
function withLimit(actions: number | undefined): Transport {
  const transport = new RecordingTransport();
  return Object.assign(transport, actions === undefined ? {} : { limits: { actions } });
}

describe('validateSession', () => {
  it('aceita kebab-case minúsculo', () => {
    expect(validateSession('atendimento')).toBe('atendimento');
    expect(validateSession('loja-2')).toBe('loja-2');
  });

  it.each(['Atendimento', 'com espaço', 'snake_case', '', '-x'])('rejeita "%s"', (session) => {
    expect(() => validateSession(session)).toThrow(BotConfigError);
  });
});

describe('buttonLimit', () => {
  it('sem limits, não há limite', () => {
    expect(buttonLimit(withLimit(undefined))).toBe(Number.POSITIVE_INFINITY);
  });

  it('aceita inteiro >= 1', () => {
    expect(buttonLimit(withLimit(1))).toBe(1);
    expect(buttonLimit(withLimit(3))).toBe(3);
  });

  it.each([0, 1.5, -2, Number.NaN])('rejeita %s com RangeError', (value) => {
    expect(() => buttonLimit(withLimit(value))).toThrow(RangeError);
  });
});

describe('resolveTransport', () => {
  it('devolve a instância pronta', () => {
    const transport = new RecordingTransport();
    expect(resolveTransport(transport, deps)).toBe(transport);
  });

  it('chama a fábrica com as deps', () => {
    const transport = new RecordingTransport();
    let received: TransportDeps | undefined;
    const resolved = resolveTransport((d) => {
      received = d;
      return transport;
    }, deps);
    expect(resolved).toBe(transport);
    expect(received).toBe(deps);
  });

  it('embrulha a fábrica que lança em BotConfigError com cause', () => {
    const boom = new Error('boom');
    const attempt = () =>
      resolveTransport(() => {
        throw boom;
      }, deps);
    expect(attempt).toThrow(BotConfigError);
    try {
      attempt();
    } catch (error) {
      expect((error as Error).cause).toBe(boom);
    }
  });

  it('rejeita transport sem método obrigatório', () => {
    const broken = new RecordingTransport(['send.text', 'quoted']);
    Object.assign(broken, { send: undefined });
    expect(() => resolveTransport(broken, deps)).toThrow(BotConfigError);
  });
});

describe('callConnect', () => {
  it('devolve a promise do connect', async () => {
    const transport = new RecordingTransport();
    await callConnect(transport);
    expect(transport.calls).toEqual(['connect']);
  });

  it('transforma throw síncrono em rejeição', async () => {
    const boom = new Error('sync');
    const transport = new RecordingTransport();
    transport.connect = () => {
      throw boom;
    };
    const promise = callConnect(transport);
    await expect(promise).rejects.toBe(boom);
  });
});

describe('isBootConflict', () => {
  it('reconhece os três erros de conflito', () => {
    const command = { plugin: 'a', definition: { name: 'x' } } as never;
    expect(isBootConflict(new CommandConflictError('x', command, command))).toBe(true);
    expect(isBootConflict(new RoleConflictError('r', 'a', 'b'))).toBe(true);
    expect(isBootConflict(new ServiceConflictError('s', 'a', 'b'))).toBe(true);
  });

  it('ignora outros erros e valores', () => {
    expect(isBootConflict(new Error('x'))).toBe(false);
    expect(isBootConflict('x')).toBe(false);
    expect(isBootConflict(undefined)).toBe(false);
  });
});
