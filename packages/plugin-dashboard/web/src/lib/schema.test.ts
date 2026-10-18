import { describe, expect, it } from 'vitest';
import {
  buildFields,
  buildOverrides,
  flatten,
  groupIssues,
  isDirty,
  leaves,
  listToRows,
  parseList,
  parseNumber,
  recordToRows,
  rowsToList,
  rowsToRecord,
  unflatten,
} from './schema.ts';

const schema = {
  type: 'object',
  required: ['token', 'name'],
  properties: {
    name: { type: 'string', description: 'Nome' },
    token: { type: 'string', secret: true, writeOnly: true },
    retries: { type: 'integer', default: 3 },
    ratio: { type: 'number' },
    on: { type: 'boolean' },
    mode: { enum: ['a', 'b'] },
    tags: { type: 'array', items: { type: 'string' } },
    sizes: { type: 'array', items: { type: 'number' } },
    maybe: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    nested: {
      type: 'object',
      properties: {
        model: { type: 'string' },
        deep: { type: 'object', properties: { x: { type: 'integer' } } },
      },
    },
    weird: { type: 'array', items: { type: 'object' } },
  },
};

describe('buildFields', () => {
  const nodes = buildFields(schema);
  const byPath = Object.fromEntries(leaves(nodes).map((f) => [f.path, f]));

  it('mapeia cada tipo para o controle', () => {
    const controls = Object.fromEntries(Object.entries(byPath).map(([k, f]) => [k, f.control]));
    expect(controls).toEqual({
      name: 'text',
      token: 'text',
      retries: 'integer',
      ratio: 'number',
      on: 'boolean',
      mode: 'enum',
      tags: 'list',
      sizes: 'list',
      maybe: 'text',
      'nested.model': 'text',
      'nested.deep.x': 'integer',
      weird: 'json',
    });
    expect(byPath['mode']?.options).toEqual(['a', 'b']);
    expect(byPath['sizes']?.item).toBe('number');
  });

  it('marca secret, obrigatório e default', () => {
    expect(byPath['token']?.secret).toBe(true);
    expect(byPath['name']?.secret).toBe(false);
    expect(byPath['name']?.required).toBe(true);
    expect(byPath['retries']?.default).toBe(3);
  });

  it('agrupa objetos aninhados', () => {
    const group = nodes.find((n) => n.node === 'group');
    expect(group?.path).toBe('nested');
  });

  it('schema nulo não gera campos', () => {
    expect(buildFields(null)).toEqual([]);
  });
});

describe('flatten / unflatten', () => {
  it('achata e desachata o path com pontos', () => {
    const value = { a: 1, b: { c: 'x', d: { e: true } }, list: [1, 2] };
    const flat = flatten(value);
    expect(flat).toEqual({ a: 1, 'b.c': 'x', 'b.d.e': true, list: [1, 2] });
    expect(unflatten(flat)).toEqual(value);
  });
});

describe('buildOverrides', () => {
  const fields = leaves(buildFields(schema));
  const initial = { name: 'a', token: '********', retries: 3, 'nested.model': 'm' };

  it('envia só o que mudou e o que já era override; nunca secret', () => {
    const current = { ...initial, name: 'b', token: 'novo' };
    const sources = { name: 'file', retries: 'override', token: 'env', 'nested.model': 'default' };
    expect(buildOverrides(fields, initial, current, sources)).toEqual({ name: 'b', retries: 3 });
  });

  it('desachata caminhos aninhados', () => {
    const current = { ...initial, 'nested.model': 'z' };
    expect(buildOverrides(fields, initial, current, {})).toEqual({ nested: { model: 'z' } });
  });

  it('detecta mudança', () => {
    expect(isDirty(initial, { ...initial })).toBe(false);
    expect(isDirty(initial, { ...initial, retries: 4 })).toBe(true);
  });
});

describe('record e messages', () => {
  const rec = {
    type: 'object',
    properties: {
      modo: { enum: ['a', 'b'] },
      extra: { type: 'object', additionalProperties: { type: 'string' } },
    },
  };
  const fields = leaves(buildFields(rec));
  const stop = new Set(fields.map((f) => f.path));

  it('o record é uma folha json com o valor atual', () => {
    expect(fields.find((f) => f.path === 'extra')?.control).toBe('json');
    expect(flatten({ modo: 'a', extra: { a: 'b' } }, '', stop)).toEqual({
      modo: 'a',
      extra: { a: 'b' },
    });
  });

  it('salvar só o modo preserva o record e messages.* que eram override', () => {
    const initial = flatten({ modo: 'a', extra: { a: 'b' } }, '', stop);
    const sources = {
      modo: 'default',
      'extra.a': 'override',
      'messages.ola': 'override',
      'messages.x': 'default',
    };
    const extra = flatten({ messages: { ola: 'Oi, {nome}!', x: 'padrão' } });
    const out = buildOverrides(fields, initial, { ...initial, modo: 'b' }, sources, extra);
    expect(out).toEqual({ modo: 'b', extra: { a: 'b' }, messages: { ola: 'Oi, {nome}!' } });
  });
});

describe('entradas', () => {
  it('number: vazio some, inválido segue cru', () => {
    expect(parseNumber('')).toBeUndefined();
    expect(parseNumber('4.5')).toBe(4.5);
    expect(parseNumber('abc')).toBe('abc');
  });
  it('lista: uma linha por item', () => {
    expect(parseList('a\n\nb', 'text')).toEqual(['a', 'b']);
    expect(parseList('1\n2', 'number')).toEqual([1, 2]);
  });
});

describe('groupIssues', () => {
  it('liga a issue ao campo pelo path e separa as órfãs', () => {
    const fields = leaves(buildFields(schema));
    const { byPath, orphans } = groupIssues(
      [
        { path: 'nested.model', message: 'ruim' },
        { path: '', message: 'geral' },
      ],
      fields,
    );
    expect(byPath['nested.model']).toEqual(['ruim']);
    expect(orphans).toEqual([{ path: '', message: 'geral' }]);
  });
});

describe('controles de lista e record', () => {
  const rec = buildFields({
    type: 'object',
    properties: {
      numeros: { type: 'object', additionalProperties: { type: 'integer' } },
      textos: { type: 'object', additionalProperties: { type: 'string' } },
      livre: { type: 'object' },
      segredo: { type: 'string', secret: true },
    },
  });
  const byPath = Object.fromEntries(leaves(rec).map((f) => [f.path, f]));

  it('record primitivo guarda o tipo do valor; o resto segue json cru', () => {
    expect(byPath['numeros']).toMatchObject({ control: 'json', record: 'number' });
    expect(byPath['textos']).toMatchObject({ control: 'json', record: 'text' });
    expect(byPath['livre']?.record).toBeUndefined();
  });

  it('lista: linhas viram itens e voltam', () => {
    expect(listToRows(['a', 'b'])).toEqual(['a', 'b']);
    expect(listToRows(undefined)).toEqual([]);
    expect(rowsToList(['a', '', 'b'], 'text')).toEqual(['a', 'b']);
    expect(rowsToList(['1', '2.5'], 'number')).toEqual([1, 2.5]);
  });

  it('record: pares viram objeto; sem chave some; vazio é ausente', () => {
    expect(recordToRows({ a: 1, b: 'x' })).toEqual([
      ['a', '1'],
      ['b', 'x'],
    ]);
    expect(
      rowsToRecord(
        [
          ['a', '1'],
          ['', 'lixo'],
        ],
        'number',
      ),
    ).toEqual({ a: 1 });
    expect(rowsToRecord([['a', 'x']], 'text')).toEqual({ a: 'x' });
    expect(rowsToRecord([], 'text')).toBeUndefined();
  });

  it('secret continua só máscara e fora do PUT', () => {
    const fields = leaves(rec);
    expect(byPath['segredo']?.secret).toBe(true);
    const out = buildOverrides(fields, {}, { segredo: 'novo', textos: { a: 'b' } }, {});
    expect(out).toEqual({ textos: { a: 'b' } });
  });
});
