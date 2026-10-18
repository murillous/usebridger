import { describe, expect, it } from 'vitest';
import { buildFields, dependentsOf, envName, hintOf, leaves } from './schema.ts';

describe('hintOf', () => {
  it('mostra tipo e limites do JSON Schema', () => {
    expect(hintOf({ enum: ['a', 'b'] })).toBe('z.enum');
    expect(hintOf({ type: 'number', minimum: 0, maximum: 1 })).toBe('z.number().min(0).max(1)');
    expect(hintOf({ type: 'string', minLength: 2 })).toBe('z.string().min(2)');
    expect(hintOf({ type: 'integer' })).toBe('z.int()');
    expect(hintOf({})).toBe('z.json()');
    expect(hintOf({ type: 'integer', minimum: -Number.MAX_SAFE_INTEGER })).toBe('z.int()');
  });

  it('vai em cada campo gerado', () => {
    const [field] = leaves(buildFields({ properties: { t: { type: 'number', maximum: 1 } } }));
    expect(field?.hint).toBe('z.number().max(1)');
  });
});

describe('envName', () => {
  it('segue o envName do core', () => {
    expect(envName('ai', 'apiKey')).toBe('BRIDGER_AI__API_KEY');
    expect(envName('user-names', 'openai.apiKey')).toBe('BRIDGER_USER_NAMES__OPENAI__API_KEY');
  });
});

describe('dependentsOf', () => {
  const rows: { name: string; dependsOn?: Record<string, string> }[] = [
    { name: 'ai' },
    { name: 'a', dependsOn: { ai: '^1' } },
    { name: 'b', dependsOn: { a: '^1' } },
    { name: 'c', dependsOn: { other: '^1' } },
  ];
  it('inclui dependentes diretos e indiretos', () => {
    expect(dependentsOf(rows, 'ai').sort()).toEqual(['a', 'b']);
    expect(dependentsOf(rows, 'c')).toEqual([]);
  });
});
