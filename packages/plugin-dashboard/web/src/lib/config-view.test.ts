import { describe, expect, it } from 'vitest';
import { badgeOf, secretOrigin, validateLocal } from './config-view.ts';
import { buildFields, leaves } from './schema.ts';
import type { PluginRow } from './types.ts';

const row = (extra: Partial<PluginRow> = {}): PluginRow => ({
  name: 'p',
  version: '1.0.0',
  origin: 'x',
  status: 'loaded',
  ...extra,
});

describe('badgeOf', () => {
  it('falhou vence a contagem; plural de erro', () => {
    const failed = row({ status: 'skipped', reason: { kind: 'setup-failed' } });
    expect(badgeOf(failed, 3)).toBe('falhou');
    expect(badgeOf(row(), 1)).toBe('1 erro');
    expect(badgeOf(row(), 2)).toBe('2 erros');
    expect(badgeOf(row(), 0)).toBeUndefined();
    expect(badgeOf(undefined, undefined)).toBeUndefined();
  });

  it('plugin que voltou a carregar perde o badge', () => {
    expect(badgeOf(row({ status: 'loaded' }), 0)).toBeUndefined();
  });
});

describe('secretOrigin', () => {
  const base = { plugin: 'ai', path: 'apiKey', hasValue: true };
  it('config inválida: origem desconhecida', () => {
    expect(secretOrigin({ ...base, known: false, source: undefined })).toMatch(/inválida/);
  });
  it('config válida sem source não diz "inválida"', () => {
    expect(secretOrigin({ ...base, known: true, source: undefined, hasValue: false })).toBe(
      'Sem valor definido.',
    );
  });
  it('default com valor não diz "sem valor"', () => {
    expect(secretOrigin({ ...base, known: true, source: 'default' })).toBe(
      'Valor padrão do plugin.',
    );
  });
  it('env e arquivo', () => {
    expect(secretOrigin({ ...base, known: true, source: 'env' })).toBe(
      'Definida por BRIDGER_AI__API_KEY.',
    );
    expect(secretOrigin({ ...base, known: true, source: 'file' })).toMatch(/arquivo/);
  });
});

describe('validateLocal', () => {
  const fields = leaves(
    buildFields({
      required: ['name'],
      properties: {
        name: { type: 'string', minLength: 2 },
        n: { type: 'number', minimum: 64, maximum: 100 },
        i: { type: 'integer' },
        mode: { enum: ['a', 'b'] },
        opt: { type: 'string', default: 'x' },
      },
    }),
  );

  it('aponta os limites sem esperar o 400', () => {
    const errors = validateLocal(fields, { name: 'x', n: 0, i: 1.5, mode: 'c' });
    expect(errors['name']).toEqual(['Mínimo de 2 caracteres']);
    expect(errors['n']).toEqual(['Deve ser maior ou igual a 64']);
    expect(errors['i']).toEqual(['Informe um inteiro']);
    expect(errors['mode']).toEqual(['Valor fora das opções']);
    expect(validateLocal(fields, {})).toEqual({});
  });

  it('valor válido, opcional vazio e texto não numérico', () => {
    expect(validateLocal(fields, { name: 'ok', n: 70, mode: 'a' })).toEqual({});
    expect(validateLocal(fields, { name: 'ok', n: '1.' })['n']).toEqual(['Informe um número']);
    expect(validateLocal(fields, { name: 'ok', n: 101 })['n']).toEqual([
      'Deve ser menor ou igual a 100',
    ]);
  });
});
