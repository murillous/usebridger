import { describe, expect, it } from 'vitest';
import { deref, type JsonSchema, type OpenApiDocument, resourcesFromSpec } from './spec.ts';

const meta = (operation: string, extra: Record<string, unknown> = {}) => ({
  'x-resource': { plugin: 'rank', resource: 'ranking', operation, ...extra },
});
const json = (schema: JsonSchema) => ({ content: { 'application/json': { schema } } });

const SPEC: OpenApiDocument = {
  components: {
    schemas: {
      RankRow: {
        type: 'object',
        properties: { id: { type: 'string' }, nome: { type: 'string' } },
      },
    },
  },
  paths: {
    '/api/resources/rank/ranking': {
      get: {
        ...meta('list'),
        'x-permission': 'rank.read',
        summary: 'Ranking',
        parameters: [
          { in: 'query', name: 'cursor', schema: { type: 'string' } },
          { in: 'query', name: 'limit', schema: { type: 'integer' } },
          { in: 'query', name: 'min', schema: { type: 'number' } },
        ],
        responses: {
          '200': json({
            type: 'object',
            properties: {
              items: { type: 'array', items: { $ref: '#/components/schemas/RankRow' } },
            },
          }),
        },
      },
      post: {
        ...meta('create'),
        'x-permission': 'rank.write',
        requestBody: json({ type: 'object', properties: { nome: { type: 'string' } } }),
        responses: { '201': json({ $ref: '#/components/schemas/RankRow' }) },
      },
    },
    '/api/resources/rank/ranking/{id}/actions/zerar': {
      post: { ...meta('action', { action: 'zerar', confirm: true }), responses: {} },
    },
    // Outra sessão do mesmo processo: não é desta tela.
    '/sessions/erp/api/resources/rank/ranking': {
      get: { ...meta('list'), responses: {} },
    },
    '/api/health': { get: { responses: {} } },
  },
};

describe('resourcesFromSpec', () => {
  it('monta o recurso da sessão com item, filtros, operações e ações', () => {
    const [view, ...rest] = resourcesFromSpec(SPEC, '/api');
    expect(rest).toEqual([]);
    expect(view).toMatchObject({
      key: 'rank/ranking',
      summary: 'Ranking',
      item: { properties: { id: { type: 'string' }, nome: { type: 'string' } } },
      filters: [{ name: 'min', schema: { type: 'number' } }],
      list: { path: '/resources/rank/ranking', permission: 'rank.read' },
      create: { permission: 'rank.write', input: { properties: { nome: { type: 'string' } } } },
      actions: [{ id: 'zerar', confirm: true, path: '/resources/rank/ranking/{id}/actions/zerar' }],
    });
  });

  it('outra sessão só vê os recursos dela', () => {
    expect(resourcesFromSpec(SPEC, '/sessions/erp/api').map((v) => v.list?.path)).toEqual([
      '/resources/rank/ranking',
    ]);
  });
});

it('deref corta ciclo de $ref', () => {
  const cyclic: OpenApiDocument = {
    components: {
      schemas: { Node: { properties: { next: { $ref: '#/components/schemas/Node' } } } },
    },
  };
  expect(deref({ $ref: '#/components/schemas/Node' }, cyclic)).toEqual({
    properties: { next: {} },
  });
});
